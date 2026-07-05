import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { resolveDrizzleSchemaDir } from "../drizzle-detect.js";
import { runInit } from "./init.js";
import { runGenerate } from "./generate.js";
import { detectPackageManager } from "../deps.js";
import {
  applyRuntimeMigrationsFromUrl,
  checkGeneratedSchemaFile,
  printGeneratedSchemaCheck,
} from "../runtime-schema.js";
import { renderKhotanRuntimeMigrationSql } from "../../factory/runtime-schema.js";

function isSchemaScaffolded(cwd: string): boolean {
  const schemaDir = resolveDrizzleSchemaDir(cwd);
  if (!schemaDir) return false;
  return fs.existsSync(path.join(cwd, schemaDir, "khotan.ts"));
}

export const migrateCommand = new Command("migrate")
  .description(
    "Generate a migration and apply it (or --push to skip migration files)",
  )
  .option("--push", "Push schema directly without generating migration files")
  .option(
    "--runtime",
    "Apply Khotan-owned runtime table upgrades after Drizzle migration",
  )
  .option(
    "--runtime-only",
    "Apply only Khotan-owned runtime table upgrades; skip Drizzle migration",
  )
  .option("--print-runtime-sql", "Print Khotan runtime upgrade SQL and exit")
  .action(
    async (opts: {
      push?: boolean;
      runtime?: boolean;
      runtimeOnly?: boolean;
      printRuntimeSql?: boolean;
    }) => {
      const cwd = process.cwd();

      if (opts.printRuntimeSql) {
        process.stdout.write(renderKhotanRuntimeMigrationSql());
        return;
      }

      if (opts.runtimeOnly) {
        await applyRuntimeMigrations(cwd);
        return;
      }

      const configPath = path.resolve(cwd, "khotan.config.ts");
      if (!fs.existsSync(configPath)) {
        console.log("No khotan.config.ts found. Running init...\n");
        const initOk = await runInit(cwd);
        if (!initOk) {
          console.error("✗ Init failed. Cannot proceed.");
          process.exit(1);
        }
        console.log("");
      }

      if (!isSchemaScaffolded(cwd)) {
        console.log("Schema not found. Running generate...\n");
        const ok = runGenerate(cwd);
        if (!ok) {
          console.error("✗ Generate failed. Cannot proceed.");
          process.exit(1);
        }
        console.log("");
      } else {
        console.log("✓ Schema already generated");
      }

      const source = checkGeneratedSchemaFile(cwd);
      if (source.check.errors.length > 0) {
        printGeneratedSchemaCheck(source);
        console.error(
          "\n✗ Generated schema is not compatible with this khotan-data runtime. Run `khotan-data generate --force` before migrating.",
        );
        process.exit(1);
      }

      const pm = detectPackageManager(cwd);
      const runner = pm.name === "npm" ? "npx" : pm.name;

      if (opts.push) {
        console.log("Pushing schema directly to database...\n");
        try {
          execSync(`${runner} drizzle-kit push`, {
            cwd,
            stdio: "inherit",
          });
          console.log("\n✓ Schema pushed to database");
        } catch {
          console.error("\n✗ drizzle-kit push failed.");
          console.error(
            "  Make sure DATABASE_URL is set and drizzle-kit is installed.",
          );
          process.exit(1);
        }
      } else {
        console.log("Generating migration...\n");
        try {
          execSync(`${runner} drizzle-kit generate`, {
            cwd,
            stdio: "inherit",
          });
          console.log("\n✓ Migration file generated");
        } catch {
          console.error("\n✗ drizzle-kit generate failed.");
          process.exit(1);
        }

        console.log("\nApplying migration...\n");
        try {
          execSync(`${runner} drizzle-kit migrate`, {
            cwd,
            stdio: "inherit",
          });
          console.log("\n✓ Migration applied successfully");
        } catch {
          console.error("\n✗ drizzle-kit migrate failed.");
          console.error(
            "  Make sure DATABASE_URL is set and drizzle-kit is installed.",
          );
          process.exit(1);
        }
      }

      if (opts.runtime) {
        await applyRuntimeMigrations(cwd);
      }
    },
  );

async function applyRuntimeMigrations(cwd: string): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("✗ DATABASE_URL is required for runtime schema migration.");
    process.exit(1);
  }

  console.log("\nApplying Khotan runtime schema upgrades...\n");
  try {
    await applyRuntimeMigrationsFromUrl(cwd, databaseUrl);
    console.log("✓ Khotan runtime schema upgrades applied");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`✗ Khotan runtime schema migration failed: ${message}`);
    process.exit(1);
  }
}
