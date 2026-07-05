import { Command } from "commander";
import { output, resolveOutputDir } from "../cli-api.js";
import {
  analyzeGeneratedFiles,
  readPackageVersion,
  type GeneratedFileReportItem,
  type GeneratedFileStatus,
} from "../scaffold.js";

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

function hasDrift(summary: DoctorSummary): boolean {
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

function printDoctorText(
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

  if (!hasDrift(summary)) {
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
  .description("Report Khotan generated scaffold drift")
  .option("--json", "Print machine-readable JSON")
  .option("--check", "Exit non-zero when generated scaffold drift is found")
  .action((opts: { json?: boolean; check?: boolean }) => {
    const cwd = process.cwd();
    const version = readPackageVersion();
    const outputDir = resolveOutputDir(cwd);
    const files = analyzeGeneratedFiles(cwd, outputDir, version);
    const summary = summarize(files);
    const drift = hasDrift(summary);

    if (opts.json) {
      output({
        ok: !opts.check || !drift,
        packageVersion: version,
        outputDir,
        summary,
        files,
      });
    } else {
      printDoctorText(version, outputDir, files);
    }

    if (opts.check && drift) {
      process.exitCode = 1;
    }
  });
