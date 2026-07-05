import fs from "node:fs";
import path from "node:path";
import { resolveOutputDir } from "./cli/cli-api.js";
import { configTemplate } from "./cli/config-template.js";
import { coreGeneratedFiles, renderStampedDefinition } from "./cli/scaffold.js";

export interface BootstrapOptions {
  cwd?: string;
  outputDir?: string;
}

export interface BootstrapResult {
  ok: boolean;
  outputDir: string;
  created: string[];
  skipped: string[];
}

function writeIfMissing(
  cwd: string,
  relPath: string,
  content: string,
  result: BootstrapResult,
): void {
  const absPath = path.join(cwd, relPath);
  if (fs.existsSync(absPath)) {
    result.skipped.push(relPath);
    return;
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf-8");
  result.created.push(relPath);
}

export async function createBootstrap(
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const outputDir = opts.outputDir ?? resolveOutputDir(cwd);
  const result: BootstrapResult = {
    ok: true,
    outputDir,
    created: [],
    skipped: [],
  };

  writeIfMissing(cwd, "khotan.config.ts", configTemplate(outputDir), result);

  for (const definition of coreGeneratedFiles(cwd, outputDir)) {
    writeIfMissing(
      cwd,
      definition.relPath,
      renderStampedDefinition(definition),
      result,
    );
  }

  return result;
}
