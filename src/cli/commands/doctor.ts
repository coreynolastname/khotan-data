import { Command } from "commander";
import { output, resolveOutputDir } from "../cli-api.js";
import {
  checkKhotanRuntimeDatabaseState,
  formatKhotanRuntimeSchemaCheck,
} from "../../factory/runtime-schema.js";
import {
  analyzeGeneratedFiles,
  readPackageVersion,
  type GeneratedFileReportItem,
  type GeneratedFileStatus,
} from "../scaffold.js";
import {
  checkGeneratedSchemaFile,
  loadRuntimeDatabaseStateFromUrl,
  printGeneratedSchemaCheck,
} from "../runtime-schema.js";

interface DoctorSummary {
  total: number;
  khotanOwned: number;
  appOwned: number;
  current: number;
  stale: number;
  modified: number;
  legacy: number;
  newer: number;
  upgradable: number;
}

interface DoctorOptions {
  json?: boolean;
  check?: boolean;
  db?: boolean;
  dbSchema?: string;
}

function summarize(files: GeneratedFileReportItem[]): DoctorSummary {
  return {
    total: files.length,
    khotanOwned: files.filter((file) => file.owner === "khotan").length,
    appOwned: files.filter((file) => file.owner === "app").length,
    current: files.filter((file) => file.status === "current").length,
    stale: files.filter((file) => file.status === "stale").length,
    modified: files.filter((file) => file.status === "modified").length,
    legacy: files.filter((file) => file.status === "legacy").length,
    newer: files.filter((file) => file.status === "newer").length,
    upgradable: files.filter((file) => file.canUpgrade).length,
  };
}

function hasScaffoldDrift(summary: DoctorSummary): boolean {
  return (
    summary.stale > 0 ||
    summary.modified > 0 ||
    summary.legacy > 0 ||
    summary.newer > 0
  );
}

function statusLabel(status: GeneratedFileStatus): string {
  return status.padEnd(9, " ");
}

function printSection(title: string, files: GeneratedFileReportItem[]): void {
  if (files.length === 0) return;
  console.log(`\n${title}`);
  for (const file of files) {
    const version = file.stamp
      ? `${file.stamp.version} -> ${file.currentVersion}`
      : `unknown -> ${file.currentVersion}`;
    const suffix =
      file.status === "current"
        ? ""
        : ` (${version}; ${file.canUpgrade ? "upgradeable" : "manual"})`;
    console.log(
      `  ${statusLabel(file.status)} ${file.relPath} [${file.templateName}]${suffix}`,
    );
  }
}

function printScaffoldDoctorText(
  version: string,
  outputDir: string,
  files: GeneratedFileReportItem[],
): void {
  const summary = summarize(files);
  console.log("Khotan doctor");
  console.log(`Package template version: ${version}`);
  console.log(`Output dir: ${outputDir}`);

  if (files.length === 0) {
    console.log("\nNo known Khotan scaffold files found.");
    return;
  }

  printSection(
    "Khotan-owned generated files:",
    files.filter((file) => file.owner === "khotan"),
  );
  printSection(
    "App-owned files at scaffold paths:",
    files.filter((file) => file.owner === "app"),
  );

  if (!hasScaffoldDrift(summary)) {
    console.log("\nAll stamped Khotan generated files are current.");
    return;
  }

  if (summary.upgradable > 0) {
    console.log(
      `\nRun \`khotan-data upgrade\` to refresh ${String(summary.upgradable)} unchanged generated file(s).`,
    );
  }
  if (summary.modified > 0 || summary.legacy > summary.upgradable) {
    console.log(
      "Files marked modified or legacy/manual are left untouched by default.",
    );
  }
}

export const doctorCommand = new Command("doctor")
  .description("Check Khotan generated scaffold drift and runtime schema shape")
  .option("--json", "Print machine-readable JSON")
  .option("--check", "Exit non-zero when generated scaffold drift is found")
  .option("--no-db", "Skip live database checks")
  .option("--db-schema <schema>", "Postgres schema to inspect")
  .action(async (opts: DoctorOptions) => {
    const cwd = process.cwd();
    const version = readPackageVersion();
    const outputDir = resolveOutputDir(cwd);
    const files = analyzeGeneratedFiles(cwd, outputDir, version);
    const scaffoldSummary = summarize(files);
    const scaffoldDrift = hasScaffoldDrift(scaffoldSummary);

    const generatedSchema = checkGeneratedSchemaFile(cwd);
    let databaseCheck: ReturnType<
      typeof checkKhotanRuntimeDatabaseState
    > | null = null;
    let databaseError: string | null = null;
    let databaseSkipped: string | null = null;

    if (opts.db === false) {
      databaseSkipped = "--no-db";
    } else {
      const databaseUrl = process.env["DATABASE_URL"];
      if (!databaseUrl) {
        databaseSkipped = "DATABASE_URL is not set";
      } else {
        try {
          const state = await loadRuntimeDatabaseStateFromUrl(
            cwd,
            databaseUrl,
            {
              ...(opts.dbSchema ? { schemaName: opts.dbSchema } : {}),
            },
          );
          databaseCheck = checkKhotanRuntimeDatabaseState(state);
        } catch (error) {
          databaseError =
            error instanceof Error ? error.message : "Unknown database error";
        }
      }
    }

    const runtimeHasErrors =
      generatedSchema.check.errors.length > 0 ||
      (databaseCheck?.errors.length ?? 0) > 0 ||
      databaseError !== null;
    const shouldFail = opts.check
      ? scaffoldDrift || runtimeHasErrors
      : !opts.json && runtimeHasErrors;

    if (opts.json) {
      output({
        ok: !shouldFail,
        packageVersion: version,
        outputDir,
        summary: scaffoldSummary,
        files,
        scaffold: {
          drift: scaffoldDrift,
          summary: scaffoldSummary,
          files,
        },
        runtime: {
          generatedSchema,
          databaseCheck,
          databaseError,
          databaseSkipped,
        },
      });
    } else {
      printScaffoldDoctorText(version, outputDir, files);
      console.log("");
      printGeneratedSchemaCheck(generatedSchema);

      if (databaseSkipped) {
        console.log(`\nSkipping database check (${databaseSkipped}).`);
      } else if (databaseError) {
        console.error(`\n✗ Database check failed: ${databaseError}`);
      } else if (databaseCheck) {
        console.log("\nChecking database runtime schema...");
        console.log(formatKhotanRuntimeSchemaCheck(databaseCheck, "Database"));
      }

      if (runtimeHasErrors) {
        console.error(
          "\nKhotan runtime schema checks failed. Run `khotan-data generate --force` for generated schema drift and `khotan-data migrate --runtime` for Khotan-owned table upgrades.",
        );
      } else {
        console.log("\n✓ Khotan doctor completed");
      }
    }

    if (shouldFail) {
      process.exitCode = 1;
    }
  });
