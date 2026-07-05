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
const fixtureRoot = path.join(repoRoot, "e2e", "fixtures");
const npmCacheDir = path.join(repoRoot, ".tmp", "npm-cache");
const npmLogsDir = path.join(repoRoot, ".tmp", "npm-logs");
const pnpmStoreDir = path.join(repoRoot, ".tmp", "pnpm-store");
const keepTemp = process.env.KHOTAN_E2E_KEEP === "1";
const fullPackageManagerMatrix = process.env.KHOTAN_E2E_FULL_PM_MATRIX === "1";
const scenarioFilter = new Set(
  (process.env.KHOTAN_E2E_SCENARIOS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
const packageManagerFilter = new Set(
  (process.env.KHOTAN_E2E_PACKAGE_MANAGERS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);

const packageManagers = {
  npm: {
    name: "npm",
    lockfile: "package-lock.json",
    command() {
      return { command: "npm", prefixArgs: [] };
    },
    installArgs(tarballPath) {
      return ["install", "--no-audit", "--no-fund", tarballPath];
    },
    typecheckArgs() {
      return ["run", "typecheck"];
    },
  },
  pnpm: {
    name: "pnpm",
    lockfile: "pnpm-lock.yaml",
    command() {
      if (commandExists("pnpm")) {
        return { command: "pnpm", prefixArgs: [] };
      }
      return { command: "npx", prefixArgs: ["--yes", "pnpm@latest"] };
    },
    installArgs(tarballPath) {
      return [
        "add",
        "--ignore-scripts",
        "--store-dir",
        pnpmStoreDir,
        tarballPath,
      ];
    },
    typecheckArgs() {
      return ["run", "typecheck"];
    },
  },
  bun: {
    name: "bun",
    lockfile: "bun.lock",
    command() {
      if (!commandExists("bun")) {
        throw new Error(
          'The E2E scenario "bun" requires bun on PATH. Install bun or set KHOTAN_E2E_PACKAGE_MANAGERS=npm,pnpm.',
        );
      }
      return { command: "bun", prefixArgs: [] };
    },
    installArgs(tarballPath) {
      return ["add", tarballPath];
    },
    typecheckArgs() {
      return ["run", "typecheck"];
    },
  },
};

const packageManagerOrder = ["npm", "pnpm", "bun"];

const scenarioTemplates = [
  {
    name: "next14-root-app",
    packageManager: "npm",
    fixture: "next14-root-app",
    commands: [["init", "--full", "--schema", "--yes"]],
    expectedFiles: [
      "khotan.config.ts",
      "khotan/khotan.ts",
      "app/api/khotan/[...all]/route.ts",
      "db/index.ts",
      "db/schema/khotan.ts",
      ".env.template",
      "AGENTS.md",
    ],
    expectedContent: [
      {
        file: "khotan.config.ts",
        text: 'outputDir: "khotan"',
      },
      {
        file: "app/api/khotan/[...all]/route.ts",
        text: 'import khotanData from "../../../../khotan/khotan"',
      },
    ],
  },
  {
    name: "next15-src-app-single-schema-config",
    packageManager: "pnpm",
    fixture: "next15-src-app",
    commands: [["init", "--full", "--schema", "--yes"]],
    expectedFiles: [
      "khotan.config.ts",
      "src/khotan/khotan.ts",
      "src/app/api/khotan/[...all]/route.ts",
      "src/db/index.ts",
      "src/db/khotan.ts",
      ".env.template",
    ],
    expectedContent: [
      {
        file: "khotan.config.ts",
        text: 'outputDir: "src/khotan"',
      },
      {
        file: "drizzle.config.ts",
        text: 'schema: "./src/db/*.ts"',
      },
      {
        file: "src/db/index.ts",
        text: 'export * from "./khotan";',
      },
    ],
  },
  {
    name: "next16-src-flow-app",
    packageManager: "bun",
    fixture: "next16-src-flow-app",
    commands: [
      ["init", "--full", "--schema", "--yes"],
      ["add", "plug", "--yes"],
      ["add", "inflow", "--yes"],
    ],
    expectedFiles: [
      "khotan.config.ts",
      "src/khotan/khotan.ts",
      "src/khotan/plugs/plug.ts",
      "src/khotan/plugs/plug.example.ts",
      "src/khotan/flows/inflow.ts",
      "src/khotan/flows/inflow.example.ts",
      "src/app/api/khotan/[...all]/route.ts",
      "src/db/schema/khotan.ts",
      "next.config.ts",
    ],
    expectedContent: [
      {
        file: "next.config.ts",
        text: 'import { withWorkflow } from "workflow/next";',
      },
      {
        file: "next.config.ts",
        text: 'serverExternalPackages: ["khotan-data"]',
      },
      {
        file: "next.config.ts",
        text: "export default withWorkflow(nextConfig);",
      },
    ],
  },
];

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function scenarioId(scenario) {
  return `${scenario.name}-${scenario.packageManager}`;
}

function expandScenarios() {
  const selected = fullPackageManagerMatrix
    ? scenarioTemplates.flatMap((template) =>
        packageManagerOrder.map((packageManager) => ({
          ...template,
          packageManager,
        })),
      )
    : scenarioTemplates;

  return selected.filter((scenario) => {
    const id = scenarioId(scenario);
    const scenarioMatches =
      scenarioFilter.size === 0 ||
      scenarioFilter.has(id) ||
      scenarioFilter.has(scenario.name) ||
      scenarioFilter.has(scenario.fixture);
    const packageManagerMatches =
      packageManagerFilter.size === 0 ||
      packageManagerFilter.has(scenario.packageManager);
    return scenarioMatches && packageManagerMatches;
  });
}

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
  console.log(
    `$ ${formatCommand(command, args)} (${path.relative(repoRoot, cwd) || "."})`,
  );
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnv(options.env ?? {}),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 180_000,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) {
    throw new Error(
      `${formatCommand(command, args)} failed: ${result.error.message}\n${stdout}${stderr}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${formatCommand(command, args)} exited ${String(result.status)}\n${stdout}${stderr}`,
    );
  }
  if (stderr.trim().length > 0) {
    process.stderr.write(stderr);
  }
  return stdout;
}

function packPackage(tmpRoot) {
  run("npm", ["run", "build"], { timeout: 180_000 });
  const output = run("npm", ["pack", "--json", "--pack-destination", tmpRoot], {
    timeout: 120_000,
  });
  const packed = JSON.parse(output);
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error(`Could not resolve npm pack output:\n${output}`);
  }
  return path.join(tmpRoot, filename);
}

function fixturePath(name) {
  return path.join(fixtureRoot, name);
}

function copyFixture(scenario, tmpRoot) {
  const source = fixturePath(scenario.fixture);
  const target = path.join(tmpRoot, scenarioId(scenario));
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function assertFile(projectDir, relPath) {
  const fullPath = path.join(projectDir, relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Expected ${relPath} to exist`);
  }
}

function assertIncludes(projectDir, relPath, text) {
  assertFile(projectDir, relPath);
  const content = fs.readFileSync(path.join(projectDir, relPath), "utf-8");
  if (!content.includes(text)) {
    throw new Error(`Expected ${relPath} to include ${JSON.stringify(text)}`);
  }
}

function assertInstalledFromTarball(projectDir, tarballPath) {
  const pkg = readJson(path.join(projectDir, "package.json"));
  const dependency = pkg.dependencies?.["khotan-data"];
  const tarballName = path.basename(tarballPath);
  if (
    typeof dependency !== "string" ||
    (!dependency.includes(tarballName) && !dependency.endsWith(".tgz"))
  ) {
    throw new Error(
      `Expected package.json dependency khotan-data to reference a tarball, got ${String(
        dependency,
      )}`,
    );
  }

  const installedPackage = readJson(
    path.join(projectDir, "node_modules", "khotan-data", "package.json"),
  );
  const sourcePackage = readJson(path.join(repoRoot, "package.json"));
  if (installedPackage.version !== sourcePackage.version) {
    throw new Error(
      `Expected installed khotan-data version ${sourcePackage.version}, got ${String(
        installedPackage.version,
      )}`,
    );
  }
}

function khotanBin(projectDir) {
  const binName =
    process.platform === "win32" ? "khotan-data.cmd" : "khotan-data";
  return path.join(projectDir, "node_modules", ".bin", binName);
}

function runPackageManager(packageManagerName, args, options = {}) {
  const packageManager = packageManagers[packageManagerName];
  if (!packageManager) {
    throw new Error(`Unknown package manager: ${packageManagerName}`);
  }

  const { command, prefixArgs } = packageManager.command();
  return run(command, [...prefixArgs, ...args], options);
}

function assertPackageManagerLockfile(projectDir, packageManagerName) {
  const packageManager = packageManagers[packageManagerName];
  if (!packageManager) {
    throw new Error(`Unknown package manager: ${packageManagerName}`);
  }

  assertFile(projectDir, packageManager.lockfile);
}

function installConsumer(scenario, projectDir, tarballPath) {
  const packageManager = packageManagers[scenario.packageManager];
  if (!packageManager) {
    throw new Error(`Unknown package manager: ${scenario.packageManager}`);
  }

  runPackageManager(
    scenario.packageManager,
    packageManager.installArgs(tarballPath),
    {
      cwd: projectDir,
      timeout: 240_000,
    },
  );
  assertInstalledFromTarball(projectDir, tarballPath);
  assertPackageManagerLockfile(projectDir, scenario.packageManager);
}

function runScenario(scenario, tarballPath, tmpRoot) {
  console.log(`\n== ${scenarioId(scenario)} ==`);
  const projectDir = copyFixture(scenario, tmpRoot);
  installConsumer(scenario, projectDir, tarballPath);

  const bin = khotanBin(projectDir);
  for (const args of scenario.commands) {
    const output = run(bin, args, {
      cwd: projectDir,
      env: { KHOTAN_SKIP_INSTALL: "1" },
      timeout: 120_000,
    });
    if (args[0] === "init" && args.includes("--full")) {
      const expected = `Detected package manager: ${scenario.packageManager}`;
      if (!output.includes(expected)) {
        throw new Error(
          `Expected init output for ${scenarioId(scenario)} to include ${JSON.stringify(
            expected,
          )}`,
        );
      }
    }
  }

  for (const relPath of scenario.expectedFiles) {
    assertFile(projectDir, relPath);
  }
  for (const check of scenario.expectedContent) {
    assertIncludes(projectDir, check.file, check.text);
  }

  const packageManager = packageManagers[scenario.packageManager];
  runPackageManager(scenario.packageManager, packageManager.typecheckArgs(), {
    cwd: projectDir,
    timeout: 240_000,
  });
  console.log(`ok ${scenarioId(scenario)}`);
}

function main() {
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.mkdirSync(npmLogsDir, { recursive: true });
  fs.mkdirSync(pnpmStoreDir, { recursive: true });

  const selectedScenarios = expandScenarios();
  if (selectedScenarios.length === 0) {
    throw new Error("No E2E scenarios selected");
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-data-e2e-"));
  let passed = false;
  try {
    const tarballPath = packPackage(tmpRoot);
    console.log(`Packed ${path.basename(tarballPath)}`);
    for (const scenario of selectedScenarios) {
      runScenario(scenario, tarballPath, tmpRoot);
    }
    passed = true;
  } finally {
    if (passed && !keepTemp) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } else {
      console.log(`E2E temp dir kept at ${tmpRoot}`);
    }
  }
}

main();
