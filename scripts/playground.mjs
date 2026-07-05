#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const playgroundDir = path.join(repoRoot, "examples", "playground");
const npmCacheDir = path.join(repoRoot, ".tmp", "npm-cache");
const npmLogsDir = path.join(repoRoot, ".tmp", "npm-logs");
const installOnly = process.argv.includes("--install-only");
const skipScaffold = process.env.KHOTAN_PLAYGROUND_SKIP_SCAFFOLD === "1";

function commandEnv(extra = {}) {
  const cache = process.env.NPM_CONFIG_CACHE ?? npmCacheDir;
  const logsDir = process.env.NPM_CONFIG_LOGS_DIR ?? npmLogsDir;
  return {
    ...process.env,
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    NPM_CONFIG_LOGS_DIR: logsDir,
    npm_config_logs_dir: logsDir,
    ...extra,
  };
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnv(options.env ?? {}),
    encoding: options.stdio === "inherit" ? undefined : "utf-8",
    stdio: options.stdio ?? "inherit",
    timeout: options.timeout,
  });

  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}`,
    );
  }

  return typeof result.stdout === "string" ? result.stdout : "";
}

function packPackage(tmpRoot) {
  run("npm", ["run", "build"], { timeout: 180_000 });
  const result = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", tmpRoot],
    {
      cwd: repoRoot,
      env: commandEnv(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 120_000,
    },
  );

  if (result.error) {
    throw new Error(`npm pack failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm pack exited ${String(result.status)}`);
  }

  const packed = JSON.parse(result.stdout);
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error(`Could not resolve npm pack output:\n${result.stdout}`);
  }
  return path.join(tmpRoot, filename);
}

function khotanBin() {
  const binName =
    process.platform === "win32" ? "khotan-data.cmd" : "khotan-data";
  return path.join(playgroundDir, "node_modules", ".bin", binName);
}

function scaffoldPlayground() {
  if (skipScaffold) return;

  const bin = khotanBin();
  const env = { KHOTAN_SKIP_INSTALL: "1" };
  run(bin, ["init"], {
    cwd: playgroundDir,
    env,
    stdio: "pipe",
    timeout: 120_000,
  });
  run(bin, ["add", "schema", "--yes"], {
    cwd: playgroundDir,
    env,
    stdio: "pipe",
    timeout: 120_000,
  });
  run(bin, ["add", "config-page-1", "--yes"], {
    cwd: playgroundDir,
    env,
    stdio: "pipe",
    timeout: 120_000,
  });
}

function main() {
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.mkdirSync(npmLogsDir, { recursive: true });

  if (!fs.existsSync(playgroundDir)) {
    throw new Error(`Missing playground directory: ${playgroundDir}`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-playground-"));
  try {
    const tarball = packPackage(tmpRoot);
    run("npm", ["install", "--package-lock=false", "--no-audit", "--no-fund"], {
      cwd: playgroundDir,
      timeout: 240_000,
    });
    run(
      "npm",
      [
        "install",
        "--no-save",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      {
        cwd: playgroundDir,
        timeout: 240_000,
      },
    );
    scaffoldPlayground();

    if (!installOnly) {
      run("npm", ["run", "dev"], {
        cwd: playgroundDir,
        stdio: "inherit",
      });
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();
