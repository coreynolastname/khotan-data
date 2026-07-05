import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { getComponent, isMultiFile } from "../registry.js";
import {
  resolveDrizzleSchemaDir,
  detectSingleFileSchema,
  updateDrizzleConfigSchema,
  syncDrizzleConfig,
} from "../drizzle-detect.js";
import { runInit } from "./init.js";
import { resolveOutputDir } from "../cli-api.js";

function loadOutputDir(projectRoot: string): string {
  return resolveOutputDir(projectRoot);
}

interface GenerateOptions {
  force?: boolean;
  yes?: boolean;
  schemaOutput?: string;
  drizzleConfig?: string;
  schemaBarrel?: string;
  migrationsOutput?: string;
  sharedDb?: boolean;
  dbPackage?: string;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function stripTsExtension(value: string): string {
  return value.replace(/\.[cm]?tsx?$/, "");
}

function relativeImportSpecifier(fromFile: string, toFile: string): string {
  let relativePath = toPosixPath(
    path.relative(path.dirname(fromFile), stripTsExtension(toFile)),
  );
  if (!relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }
  return relativePath;
}

function resolveSchemaOutputPath(
  cwd: string,
  schemaOutput: string | undefined,
  defaultFileName: string,
  fallbackDir: string,
): string {
  if (!schemaOutput) {
    return path.join(path.resolve(cwd, fallbackDir), defaultFileName);
  }

  const resolved = path.resolve(cwd, schemaOutput);
  if (/\.tsx?$/.test(path.basename(schemaOutput))) {
    return resolved;
  }
  return path.join(resolved, defaultFileName);
}

function applySchemaHeaderHint(
  content: string,
  reExportSpecifier: string | null,
): string {
  if (!reExportSpecifier) return content;
  return content.replace(
    `// Re-export from your Drizzle schema barrel file:\n//   export * from "@/lib/khotan/schema";`,
    `// Re-export from your Drizzle schema barrel file:\n//   export * from "${reExportSpecifier}";`,
  );
}

function upsertSchemaBarrel(
  cwd: string,
  barrelPath: string,
  schemaOutputPath: string,
): void {
  const exportSpecifier = relativeImportSpecifier(barrelPath, schemaOutputPath);
  const exportLine = `export * from "${exportSpecifier}";`;
  const relBarrel = path.relative(cwd, barrelPath);

  if (!fs.existsSync(barrelPath)) {
    fs.mkdirSync(path.dirname(barrelPath), { recursive: true });
    fs.writeFileSync(barrelPath, `${exportLine}\n`, "utf-8");
    console.log(`✓ Created ${relBarrel} with khotan re-export`);
    return;
  }

  const content = fs.readFileSync(barrelPath, "utf-8");
  if (
    content.includes(exportLine) ||
    content.includes(`'${exportSpecifier}'`)
  ) {
    console.log(`✓ ${relBarrel} already re-exports khotan`);
    return;
  }

  const separator = content.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(barrelPath, `${separator}${exportLine}\n`);
  console.log(`✓ Updated ${relBarrel} with khotan re-export`);
}

function printReExportHint(): void {
  console.log(`\nAdd this re-export to your Drizzle schema barrel file:\n`);
  console.log(`  export * from "./khotan";`);
}

function hasSrcLayout(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "src", "app"));
}

function runtimeConfigPath(cwd: string): string {
  return path.join(cwd, resolveOutputDir(cwd), "khotan.ts");
}

function routePath(cwd: string): string {
  return path.join(
    cwd,
    hasSrcLayout(cwd)
      ? "src/app/api/khotan/[...all]/route.ts"
      : "app/api/khotan/[...all]/route.ts",
  );
}

function validateSharedRuntime(
  cwd: string,
  dbPackage: string | undefined,
): void {
  console.log("\nShared runtime validation:");

  const configPath = runtimeConfigPath(cwd);
  if (!fs.existsSync(configPath)) {
    console.warn(
      `⚠ Could not find ${path.relative(cwd, configPath)} to validate runtime imports.`,
    );
  } else {
    const content = fs.readFileSync(configPath, "utf-8");
    const relConfig = path.relative(cwd, configPath);
    const importsFactory =
      /from\s+["']khotan-data\/factory["']/.test(content) &&
      content.includes("drizzleAdapter");
    const usesAdapter = /adapter:\s*drizzleAdapter\s*\(\s*db\s*\)/.test(
      content,
    );

    if (importsFactory && usesAdapter) {
      console.log(`✓ ${relConfig} uses drizzleAdapter(db)`);
    } else {
      console.warn(
        `⚠ ${relConfig} should import drizzleAdapter from "khotan-data/factory" and pass adapter: drizzleAdapter(db).`,
      );
    }

    if (dbPackage) {
      const escaped = dbPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const importsSharedDb = new RegExp(`from\\s+["']${escaped}["']`).test(
        content,
      );
      if (importsSharedDb) {
        console.log(`✓ ${relConfig} imports db from "${dbPackage}"`);
      } else {
        console.warn(
          `⚠ ${relConfig} should import its db instance from "${dbPackage}".`,
        );
      }
    }
  }

  const apiRoutePath = routePath(cwd);
  if (!fs.existsSync(apiRoutePath)) {
    console.warn(
      `⚠ Could not find ${path.relative(cwd, apiRoutePath)} to validate route binding.`,
    );
    return;
  }

  const routeContent = fs.readFileSync(apiRoutePath, "utf-8");
  const relRoute = path.relative(cwd, apiRoutePath);
  if (
    /from\s+["']khotan-data\/factory["']/.test(routeContent) &&
    routeContent.includes("toNextJsHandler(")
  ) {
    console.log(`✓ ${relRoute} uses toNextJsHandler`);
  } else {
    console.warn(
      `⚠ ${relRoute} should import toNextJsHandler from "khotan-data/factory".`,
    );
  }
}

function printSharedInstructions(opts: {
  dbPackage?: string | undefined;
  barrelPath?: string | undefined;
  drizzleConfigPath?: string | undefined;
  migrationsOutput?: string | undefined;
}): void {
  console.log("\nShared database package wiring:");
  if (opts.barrelPath) {
    console.log(`  Re-exported schema from ${opts.barrelPath}`);
  }
  if (opts.drizzleConfigPath) {
    console.log(`  Run Drizzle Kit with ${opts.drizzleConfigPath}`);
  }
  if (opts.migrationsOutput) {
    console.log(`  Migrations output: ${opts.migrationsOutput}`);
  }
  if (opts.dbPackage) {
    console.log(`  In the app runtime, import db from "${opts.dbPackage}"`);
    console.log(`  Keep drizzleAdapter imported from "khotan-data/factory"`);
  }
}

export function runGenerate(cwd: string, opts: GenerateOptions = {}): boolean {
  const schema = getComponent("schema");
  if (
    !schema ||
    isMultiFile(schema) ||
    !schema.templatePath ||
    !schema.outputFile
  ) {
    console.error("✗ Could not find schema component in registry.");
    return false;
  }

  if (opts.sharedDb && !opts.schemaOutput) {
    console.error("✗ --shared-db requires --schema-output.");
    return false;
  }

  if (opts.migrationsOutput && !opts.drizzleConfig) {
    console.error("✗ --migrations-output requires --drizzle-config.");
    return false;
  }

  const sharedMode =
    opts.sharedDb === true ||
    Boolean(opts.schemaOutput) ||
    Boolean(opts.drizzleConfig) ||
    Boolean(opts.schemaBarrel) ||
    Boolean(opts.dbPackage);

  let outputDir = loadOutputDir(cwd);
  const schemaDir =
    opts.sharedDb || opts.schemaOutput
      ? null
      : opts.drizzleConfig
        ? resolveDrizzleSchemaDir(cwd, { configPath: opts.drizzleConfig })
        : resolveDrizzleSchemaDir(cwd);
  if (!opts.schemaOutput && schemaDir) {
    outputDir = schemaDir;
    console.log(`✓ Detected Drizzle schema directory: ${schemaDir}`);
  } else if (opts.schemaOutput && opts.sharedDb) {
    console.log("✓ Shared database package mode enabled");
  }

  const outputPath = resolveSchemaOutputPath(
    cwd,
    opts.schemaOutput,
    schema.outputFile,
    outputDir,
  );
  const absOutputDir = path.dirname(outputPath);

  const factoryConfigPath = path.resolve(
    cwd,
    resolveOutputDir(cwd),
    "khotan.ts",
  );
  if (path.resolve(outputPath) === factoryConfigPath) {
    console.error(
      `✗ Refusing to write the Drizzle schema over the factory config (${path.relative(cwd, factoryConfigPath)}).`,
    );
    return false;
  }

  if (opts.schemaBarrel) {
    const barrelPath = path.resolve(cwd, opts.schemaBarrel);
    if (path.resolve(barrelPath) === path.resolve(outputPath)) {
      console.error(
        "✗ --schema-barrel must be different from --schema-output.",
      );
      return false;
    }
  }

  // Non-destructive: warn before overwriting unless --force or --yes
  if (fs.existsSync(outputPath) && !opts.force) {
    if (opts.yes) {
      console.log(
        `⚠ Overwriting ${path.relative(cwd, outputPath)} (--yes passed)`,
      );
    } else if (process.stdin.isTTY) {
      // In interactive mode, we can't use async prompts from a sync function.
      // Print an error and ask the user to pass --force.
      console.error(
        `✗ ${path.relative(cwd, outputPath)} already exists. Pass --force to overwrite.`,
      );
      return false;
    } else {
      console.error(
        `✗ ${path.relative(cwd, outputPath)} already exists. Pass --force to overwrite.`,
      );
      return false;
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const explicitBarrelPath = opts.schemaBarrel
    ? path.resolve(cwd, opts.schemaBarrel)
    : null;
  const content = applySchemaHeaderHint(
    fs.readFileSync(schema.templatePath, "utf-8"),
    explicitBarrelPath
      ? relativeImportSpecifier(explicitBarrelPath, outputPath)
      : null,
  );
  fs.writeFileSync(outputPath, content, "utf-8");
  console.log(`✓ Created ${path.relative(cwd, outputPath)}`);

  if (opts.drizzleConfig) {
    const schemaPathForConfig = explicitBarrelPath ?? outputPath;
    const drizzleConfig = syncDrizzleConfig(cwd, {
      configPath: opts.drizzleConfig,
      schemaPath: path.relative(cwd, schemaPathForConfig),
      migrationsOutput: opts.migrationsOutput,
    });
    const relConfig = path.relative(cwd, drizzleConfig.path);
    if (drizzleConfig.status === "created") {
      const outValue = drizzleConfig.outValue ?? "./drizzle";
      console.log(
        `✓ Created ${relConfig}: schema "${drizzleConfig.schemaValue}", out "${outValue}"`,
      );
    } else if (drizzleConfig.status === "updated") {
      console.log(
        `✓ Updated ${relConfig}: ${drizzleConfig.updatedFields.join(", ")}`,
      );
    } else if (drizzleConfig.status === "unchanged") {
      console.log(`✓ ${relConfig} already points at the shared schema`);
    } else {
      console.warn(
        `⚠ Could not update ${relConfig} automatically. Set schema to "${drizzleConfig.schemaValue}" manually.`,
      );
    }
  }

  // Update drizzle.config.ts if schema points to a single file
  const singleFile =
    opts.drizzleConfig || opts.sharedDb || opts.schemaOutput
      ? null
      : detectSingleFileSchema(cwd);
  if (singleFile) {
    const relConfig = path.relative(cwd, singleFile.configPath);
    const updated = updateDrizzleConfigSchema(
      singleFile.configPath,
      singleFile.currentValue,
      singleFile.globValue,
    );
    if (updated) {
      console.log(`✓ Updated ${relConfig}: schema → "${singleFile.globValue}"`);
    } else {
      console.warn(
        `⚠ Could not update ${relConfig} automatically. Set schema to "${singleFile.globValue}" manually.`,
      );
    }
  }

  // Update barrel file with khotan re-export
  if (explicitBarrelPath) {
    upsertSchemaBarrel(cwd, explicitBarrelPath, outputPath);
  } else {
    const barrelPath = path.join(absOutputDir, "index.ts");
    if (fs.existsSync(barrelPath)) {
      const barrelContent = fs.readFileSync(barrelPath, "utf-8");
      const relBarrel = path.relative(cwd, barrelPath);

      if (barrelContent.includes("./khotan")) {
        console.log(`✓ ${relBarrel} already re-exports khotan`);
      } else {
        const separator = barrelContent.endsWith("\n") ? "" : "\n";
        fs.appendFileSync(
          barrelPath,
          `${separator}export * from "./khotan";\n`,
        );
        console.log(`✓ Updated ${relBarrel} with khotan re-export`);
      }
    } else if (sharedMode) {
      printReExportHint();
    }
  }

  if (sharedMode) {
    printSharedInstructions({
      dbPackage: opts.dbPackage,
      barrelPath: explicitBarrelPath
        ? path.relative(cwd, explicitBarrelPath)
        : undefined,
      drizzleConfigPath: opts.drizzleConfig,
      migrationsOutput: opts.migrationsOutput,
    });
    if (opts.sharedDb || opts.dbPackage) {
      validateSharedRuntime(cwd, opts.dbPackage);
    }
  }

  return true;
}

export const generateCommand = new Command("generate")
  .description(
    "Generate the Khotan schema file and wire it into your Drizzle config",
  )
  .option("-f, --force", "Overwrite existing files without prompting")
  .option("-y, --yes", "Auto-accept all prompts")
  .option(
    "--schema-output <path>",
    "Write the generated schema to an explicit file or directory",
  )
  .option(
    "--drizzle-config <path>",
    "Create or update a Drizzle config at this path",
  )
  .option(
    "--schema-barrel <path>",
    "Create or update a schema barrel that re-exports the generated schema",
  )
  .option(
    "--migrations-output <path>",
    "Set the Drizzle migrations output directory when --drizzle-config is used",
  )
  .option(
    "--shared-db",
    "Shared database package mode; do not use app-local Drizzle detection",
  )
  .option(
    "--db-package <specifier>",
    "Workspace package specifier that exports the shared db instance",
  )
  .action(async (opts: GenerateOptions) => {
    const cwd = process.cwd();

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

    const ok = runGenerate(cwd, opts);
    if (!ok) process.exit(1);
  });
