import { Command } from "commander";
import {
  checkKhotanRuntimeDatabaseState,
  formatKhotanRuntimeSchemaCheck,
} from "../../factory/runtime-schema.js";
import {
  checkGeneratedSchemaFile,
  loadRuntimeDatabaseStateFromUrl,
  printGeneratedSchemaCheck,
} from "../runtime-schema.js";

export const doctorCommand = new Command("doctor")
  .description("Check Khotan generated schema and runtime database shape")
  .option("--no-db", "Skip live database checks")
  .option("--db-schema <schema>", "Postgres schema to inspect")
  .action(async (opts: { db?: boolean; dbSchema?: string }) => {
    const cwd = process.cwd();
    let hasErrors = false;

    const source = checkGeneratedSchemaFile(cwd);
    printGeneratedSchemaCheck(source);
    if (source.check.errors.length > 0) {
      hasErrors = true;
    }

    if (opts.db === false) {
      console.log("\nSkipping database check (--no-db).");
    } else {
      const databaseUrl = process.env["DATABASE_URL"];
      if (!databaseUrl) {
        console.log("\nSkipping database check (DATABASE_URL is not set).");
      } else {
        console.log("\nChecking database runtime schema...");
        try {
          const state = await loadRuntimeDatabaseStateFromUrl(
            cwd,
            databaseUrl,
            {
              ...(opts.dbSchema ? { schemaName: opts.dbSchema } : {}),
            },
          );
          const check = checkKhotanRuntimeDatabaseState(state);
          console.log(formatKhotanRuntimeSchemaCheck(check, "Database"));
          if (check.errors.length > 0) {
            hasErrors = true;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown database error";
          console.error(`✗ Database check failed: ${message}`);
          hasErrors = true;
        }
      }
    }

    if (hasErrors) {
      console.error(
        "\nKhotan runtime schema checks failed. Run `khotan-data generate --force` for generated schema drift and `khotan-data migrate --runtime` for Khotan-owned table upgrades.",
      );
      process.exit(1);
    }

    console.log("\n✓ Khotan doctor completed");
  });
