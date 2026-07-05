import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { ensureWorkflowNextConfig } from "./next-config.js";

const CLI_PATH = path.resolve(__dirname, "../../dist/cli.js");

function run(
  args: string,
  cwd: string,
  timeout = 60_000,
): { output: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args} 2>&1`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      env: { ...process.env, KHOTAN_SKIP_INSTALL: "1" },
    });
    return { output: stdout, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      output: (e.stdout ?? "") + (e.stderr ?? ""),
      exitCode: e.status ?? 1,
    };
  }
}

function runAsync(
  args: string[],
  cwd: string,
  timeout = 60_000,
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [CLI_PATH, ...args],
      {
        cwd,
        encoding: "utf-8",
        timeout,
        env: { ...process.env, KHOTAN_SKIP_INSTALL: "1" },
      },
      (error, stdout, stderr) => {
        const exitCode =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({ output: stdout + stderr, exitCode });
      },
    );
  });
}

function writePkgJson(
  dir: string,
  deps: Record<string, string> = {},
  devDeps: Record<string, string> = {},
): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: deps, devDependencies: devDeps }),
  );
}

function parseCliJson(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function installFakeNpm(cwd: string): () => void {
  const originalPath = process.env.PATH;
  const binDir = path.join(cwd, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "npm"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const args = process.argv.slice(2);",
      'fs.appendFileSync(path.join(process.cwd(), "npm-args.log"), `${args.join(" ")}\\n`);',
      'if (args[0] === "install") {',
      '  const isDev = args.includes("--save-dev") || args.includes("-D") || args.includes("-d");',
      '  const packages = args.slice(1).filter((arg) => !arg.startsWith("-"));',
      '  const pkgPath = path.join(process.cwd(), "package.json");',
      '  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf-8")) : {};',
      '  const key = isDev ? "devDependencies" : "dependencies";',
      "  pkg[key] = pkg[key] || {};",
      '  for (const name of packages) pkg[key][name] = "0.0.0-test";',
      "  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));",
      "}",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return () => {
    process.env.PATH = originalPath;
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

describe("CLI", { timeout: 30_000 }, () => {
  let tmpDir: string;
  let restorePath: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-cli-test-"));
    restorePath = undefined;
  });

  afterEach(() => {
    restorePath?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates khotan.config.ts with src/khotan when src/app exists", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created khotan.config.ts");

      const content = fs.readFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        "utf-8",
      );
      expect(content).toContain('"src/khotan"');
    });

    it("creates khotan.config.ts with khotan when app is top-level", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        "utf-8",
      );
      expect(content).toContain('"khotan"');
    });

    it("defaults to src/khotan when no app directory exists", () => {
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = fs.readFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        "utf-8",
      );
      expect(content).toContain('"src/khotan"');
    });

    it("warns when config already exists", () => {
      fs.writeFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        "existing config",
      );
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("already exists");

      const content = fs.readFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        "utf-8",
      );
      expect(content).toBe("existing config");
    });

    it("scaffolds khotan.ts and route.ts alongside config", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);

      expect(
        fs.existsSync(path.join(tmpDir, "src", "khotan", "khotan.ts")),
      ).toBe(true);
      const khotanContent = fs.readFileSync(
        path.join(tmpDir, "src", "khotan", "khotan.ts"),
        "utf-8",
      );
      expect(khotanContent).toContain("raw Node/Bun script");
      expect(khotanContent).toContain("npx khotan-data flows trigger");
      expect(
        fs.existsSync(
          path.join(
            tmpDir,
            "src",
            "app",
            "api",
            "khotan",
            "[...all]",
            "route.ts",
          ),
        ),
      ).toBe(true);
    });

    it("creates .env.template with khotan environment variables", () => {
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created .env.template");

      const content = fs.readFileSync(
        path.join(tmpDir, ".env.template"),
        "utf-8",
      );
      expect(content).toContain("DATABASE_URL=");
      expect(content).toContain("KHOTAN_SECRET=");
      expect(content).toContain("openssl rand -hex 32");
      expect(content).toContain("KHOTAN_DEBUG=1");
      expect(content).toContain("KHOTAN_WEBHOOK_URL=");
      expect(content).toContain("CRON_SECRET=");
    });

    it("appends missing khotan variables to existing .env.template", () => {
      fs.writeFileSync(
        path.join(tmpDir, ".env.template"),
        "DATABASE_URL=postgres://existing\n",
      );
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Updated .env.template");

      const content = fs.readFileSync(
        path.join(tmpDir, ".env.template"),
        "utf-8",
      );
      expect(content.match(/^DATABASE_URL=/gm)).toHaveLength(1);
      expect(content).toContain("KHOTAN_SECRET=");
      expect(content).toContain("CRON_SECRET=");
    });

    it("never overwrites existing khotan.ts or route.ts", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);

      const khotanPath = path.join(tmpDir, "khotan", "khotan.ts");
      const routePath = path.join(
        tmpDir,
        "app",
        "api",
        "khotan",
        "[...all]",
        "route.ts",
      );
      fs.writeFileSync(khotanPath, "// user modified");
      fs.writeFileSync(routePath, "// user route");

      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("already exists");

      expect(fs.readFileSync(khotanPath, "utf-8")).toBe("// user modified");
      expect(fs.readFileSync(routePath, "utf-8")).toBe("// user route");
    });

    it("--skills-only installs skills without scaffolding core files", () => {
      // Pre-create an agent marker so skills install deterministically.
      fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });

      const result = run("init --skills-only --yes", tmpDir);
      expect(result.exitCode).toBe(0);

      // A known skill landed under the detected agent root.
      expect(
        fs.existsSync(
          path.join(tmpDir, ".cursor", "skills", "khotan-build", "SKILL.md"),
        ),
      ).toBe(true);

      // No runtime code files were scaffolded.
      expect(fs.existsSync(path.join(tmpDir, "khotan.config.ts"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "khotan", "khotan.ts"))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(tmpDir, "src", "khotan", "khotan.ts")),
      ).toBe(false);
    });

    it("rejects --skills-only combined with --full", () => {
      const result = run("init --skills-only --full", tmpDir);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("cannot be combined");
    });

    it("supports init --schema", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(
        tmpDir,
        {
          "drizzle-orm": "^0.35.0",
          "khotan-data": "^0.0.1",
        },
        { "drizzle-kit": "^0.25.0" },
      );
      const result = run("init --schema --yes", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Adding khotan Drizzle schema");
      expect(
        fs.existsSync(path.join(tmpDir, "db", "schema", "khotan.ts")),
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "drizzle.config.ts"))).toBe(true);
    });

    it("installs drizzle-kit as a dev dependency for init --schema", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, {
        "drizzle-orm": "^0.35.0",
        "khotan-data": "^0.0.1",
      });
      restorePath = installFakeNpm(tmpDir);

      const result = run("init --schema --yes", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Installing drizzle-kit (dev)");

      const pkg = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"),
      ) as { devDependencies?: Record<string, string> };
      expect(pkg.devDependencies?.["drizzle-kit"]).toBe("0.0.0-test");
      expect(fs.existsSync(path.join(tmpDir, "drizzle.config.ts"))).toBe(true);
    });
  });

  describe("ops/devx commands", () => {
    it("loads --env-file and asserts the expected org", () => {
      fs.writeFileSync(
        path.join(tmpDir, ".env.khotan"),
        "KHOTAN_ORG_ID=org_123\n",
      );

      const result = run(
        "--env-file .env.khotan whoami --assert-org org_123",
        tmpDir,
      );

      expect(result.exitCode).toBe(0);
      expect(parseCliJson(result.output)).toMatchObject({
        ok: true,
        organizationId: "org_123",
        assertedOrganizationId: "org_123",
      });
    });

    it("fails whoami when the resolved org does not match --assert-org", () => {
      const result = run(
        "whoami --org-id org_actual --assert-org org_expected",
        tmpDir,
      );

      expect(result.exitCode).toBe(1);
      expect(parseCliJson(result.output)).toMatchObject({
        ok: false,
        error: "org_mismatch",
      });
    });

    it("stores local database bindings and prepares app env metadata", () => {
      const bind = run(
        "databases bind primary neon/project/db --url-env PRIMARY_DATABASE_URL",
        tmpDir,
      );
      expect(bind.exitCode).toBe(0);
      expect(parseCliJson(bind.output)).toMatchObject({
        ok: true,
        binding: {
          alias: "primary",
          id: "neon/project/db",
          urlEnv: "PRIMARY_DATABASE_URL",
        },
      });

      const prepare = run(
        "apps env prepare web --database primary --key DATABASE_URL",
        tmpDir,
      );
      expect(prepare.exitCode).toBe(0);
      expect(parseCliJson(prepare.output)).toMatchObject({
        ok: true,
        binding: {
          app: "web",
          envKey: "DATABASE_URL",
          databaseAlias: "primary",
          databaseId: "neon/project/db",
        },
      });

      const registry = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "khotan.bindings.json"), "utf-8"),
      ) as {
        databases: Record<string, unknown>;
        apps: Record<string, { env: Record<string, unknown> }>;
      };
      expect(registry.databases["primary"]).toMatchObject({
        id: "neon/project/db",
      });
      expect(registry.apps["web"]?.env["DATABASE_URL"]).toMatchObject({
        databaseAlias: "primary",
      });
    });

    it("bootstraps config, khotan instance, and route files without package installs", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });

      const result = run("bootstrap", tmpDir);

      expect(result.exitCode).toBe(0);
      expect(parseCliJson(result.output)).toMatchObject({
        ok: true,
        outputDir: "src/khotan",
      });
      expect(fs.existsSync(path.join(tmpDir, "khotan.config.ts"))).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, "src", "khotan", "khotan.ts")),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            tmpDir,
            "src",
            "app",
            "api",
            "khotan",
            "[...all]",
            "route.ts",
          ),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "package.json"))).toBe(false);
    });

    it("bootstraps empty projects with the shared outputDir default", () => {
      const result = run("bootstrap", tmpDir);

      expect(result.exitCode).toBe(0);
      expect(parseCliJson(result.output)).toMatchObject({
        ok: true,
        outputDir: "src/khotan",
      });
      expect(
        fs.existsSync(path.join(tmpDir, "src", "khotan", "khotan.ts")),
      ).toBe(true);
    });
  });

  describe("add", () => {
    it("creates plug.ts at detected output path (top-level app)", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);
      const result = run("add plug", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created");

      const plugPath = path.join(tmpDir, "khotan", "plugs", "plug.ts");
      expect(fs.existsSync(plugPath)).toBe(true);

      const content = fs.readFileSync(plugPath, "utf-8");
      expect(content).toContain("export class Plug");
      expect(content).toContain("export function plug");
      expect(content).toContain("export function bearer");
      expect(content).not.toContain('from "khotan-data"');
      expect(content).not.toContain("from 'khotan-data'");
    });

    it("creates plug.ts at detected output path (src/app)", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      run("init", tmpDir);
      const result = run("add plug", tmpDir);
      expect(result.exitCode).toBe(0);

      const plugPath = path.join(tmpDir, "src", "khotan", "plugs", "plug.ts");
      expect(fs.existsSync(plugPath)).toBe(true);
    });

    it("lazily runs init when no config exists", () => {
      writePkgJson(tmpDir, { "khotan-data": "^0.0.1" });
      const result = run("add plug", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Running init");
      expect(result.output).toContain("Created khotan.config.ts");
      expect(fs.existsSync(path.join(tmpDir, "khotan.config.ts"))).toBe(true);
    });

    it("installs drizzle-kit when add schema scaffolds config after init", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, {
        "drizzle-orm": "^0.35.0",
        "khotan-data": "^0.0.1",
      });
      restorePath = installFakeNpm(tmpDir);

      const result = run("add schema --yes", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("No khotan.config.ts found");
      expect(result.output).toContain("Installing drizzle-kit (dev)");
      expect(fs.existsSync(path.join(tmpDir, "drizzle.config.ts"))).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, "db", "schema", "khotan.ts")),
      ).toBe(true);

      const pkg = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"),
      ) as { devDependencies?: Record<string, string> };
      expect(pkg.devDependencies?.["drizzle-kit"]).toBe("0.0.0-test");
    });

    it("scaffolds Better Auth and wires khotan authorize", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      writePkgJson(tmpDir, {
        "better-auth": "^1.0.0",
        "khotan-data": "^0.0.1",
      });
      run("init", tmpDir);

      const result = run("add auth --yes", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created 2 files");
      expect(result.output).toContain("Wired authorize hook");

      const authPath = path.join(tmpDir, "src", "lib", "auth.ts");
      const authRoutePath = path.join(
        tmpDir,
        "src",
        "app",
        "api",
        "auth",
        "[...all]",
        "route.ts",
      );
      const khotanPath = path.join(tmpDir, "src", "khotan", "khotan.ts");

      expect(fs.existsSync(authPath)).toBe(true);
      expect(fs.existsSync(authRoutePath)).toBe(true);

      const authContent = fs.readFileSync(authPath, "utf-8");
      expect(authContent).toContain("betterAuth");
      expect(authContent).toContain("genericOAuth");
      expect(authContent).toContain("oAuthProxy");
      expect(authContent).toContain("authorizeKhotanRequest");

      const khotanContent = fs.readFileSync(khotanPath, "utf-8");
      expect(khotanContent).toContain(
        'import { authorizeKhotanRequest } from "@/lib/auth";',
      );
      expect(khotanContent).toContain("authorize: authorizeKhotanRequest");
    });

    it("creates khotan.ts schema at detected Drizzle schema dir", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/schema/*" };`,
      );
      run("init", tmpDir);
      const result = run("add schema", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Detected Drizzle schema directory");
      expect(result.output).toContain("Created");

      const schemaPath = path.join(tmpDir, "db", "schema", "khotan.ts");
      expect(fs.existsSync(schemaPath)).toBe(true);

      const content = fs.readFileSync(schemaPath, "utf-8");
      expect(content).toContain("khotan_plugs");
      expect(content).toContain("khotan_flows");
      expect(content).toContain("khotan_runs");
      expect(content).toContain("khotan_caches");
      expect(content).toContain("khotan_cache_entries");
      expect(content).not.toContain('from "khotan-data"');
      expect(content).not.toContain("from 'khotan-data'");
    });

    it("creates cache templates under caches", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(
        tmpDir,
        { "drizzle-orm": "^0.35.0" },
        { "drizzle-kit": "^0.25.0" },
      );
      run("init", tmpDir);

      const result = run("add cache --yes", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created");

      const cachePath = path.join(tmpDir, "khotan", "caches", "cache.ts");
      const examplePath = path.join(
        tmpDir,
        "khotan",
        "caches",
        "cache.example.ts",
      );
      expect(fs.existsSync(cachePath)).toBe(true);
      expect(fs.existsSync(examplePath)).toBe(true);

      const content = fs.readFileSync(cachePath, "utf-8");
      expect(content).toContain("export function cache");
      expect(content).toContain("cin7-products-snapshot");
      expect(fs.readFileSync(examplePath, "utf-8")).toContain(
        "cin7ProductsSnapshotCache",
      );
    });

    it.each(["inflow", "outflow", "relay"])(
      "creates %s flow template under flows",
      (component) => {
        fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
        writePkgJson(
          tmpDir,
          {
            "drizzle-orm": "^0.35.0",
            workflow: "^4.0.0",
            zod: "^3.22.0",
          },
          { "drizzle-kit": "^0.25.0" },
        );
        run("init", tmpDir);
        const result = run(`add ${component} --yes`, tmpDir, 90_000);
        expect(result.exitCode).toBe(0);

        const flowPath = path.join(
          tmpDir,
          "khotan",
          "flows",
          `${component}.ts`,
        );
        const examplePath = path.join(
          tmpDir,
          "khotan",
          "flows",
          `${component}.example.ts`,
        );
        expect(fs.existsSync(flowPath)).toBe(true);
        expect(fs.existsSync(examplePath)).toBe(true);
        expect(fs.readFileSync(flowPath, "utf-8")).toContain(
          "FlowRegistration",
        );
        expect(fs.readFileSync(flowPath, "utf-8")).toContain('"use workflow"');
        expect(fs.readFileSync(examplePath, "utf-8")).toContain(
          '"use workflow"',
        );
      },
      90_000,
    );

    it("creates ingest helper, example handler, and internal route", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, {
        "drizzle-orm": "^0.35.0",
        zod: "^3.22.0",
      });
      run("init", tmpDir);
      const result = run("add ingest --yes", tmpDir, 90_000);
      expect(result.exitCode).toBe(0);

      const helperPath = path.join(tmpDir, "khotan", "ingests", "ingest.ts");
      const examplePath = path.join(
        tmpDir,
        "khotan",
        "ingests",
        "ingest.example.ts",
      );
      const routePath = path.join(
        tmpDir,
        "app",
        "api",
        "internal",
        "khotan",
        "ingest",
        "example",
        "route.ts",
      );

      expect(fs.existsSync(helperPath)).toBe(true);
      expect(fs.existsSync(examplePath)).toBe(true);
      expect(fs.existsSync(routePath)).toBe(true);

      expect(fs.readFileSync(helperPath, "utf-8")).toContain(
        'from "khotan-data/factory"',
      );
      expect(fs.readFileSync(examplePath, "utf-8")).toContain(
        "idempotencyStore",
      );
      expect(fs.readFileSync(examplePath, "utf-8")).toContain(
        "unresolved_intake",
      );
      expect(fs.readFileSync(examplePath, "utf-8")).toContain(
        "upsertProviderRef",
      );
      expect(fs.readFileSync(routePath, "utf-8")).toContain(
        'from "@/khotan/ingests/ingest.example"',
      );
      expect(fs.readFileSync(routePath, "utf-8")).toContain(
        "packiyoInventoryIngest.POST",
      );
    });

    it("uses configured outputDir in the generated ingest route import", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, {
        "drizzle-orm": "^0.35.0",
        zod: "^3.22.0",
      });
      fs.writeFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        `export default { outputDir: "lib/custom" };`,
      );

      const result = run("add ingest --yes", tmpDir, 90_000);
      expect(result.exitCode).toBe(0);

      const routePath = path.join(
        tmpDir,
        "app",
        "api",
        "internal",
        "khotan",
        "ingest",
        "example",
        "route.ts",
      );
      const routeContent = fs.readFileSync(routePath, "utf-8");

      expect(
        fs.existsSync(
          path.join(tmpDir, "lib", "custom", "ingests", "ingest.example.ts"),
        ),
      ).toBe(true);
      expect(routeContent).toContain(
        'from "@/lib/custom/ingests/ingest.example"',
      );
      expect(routeContent).not.toContain("@/khotan/ingests/ingest.example");
    });

    it("scaffolds drizzle.config.ts and schema directory when no drizzle config exists", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      run("init", tmpDir);
      const result = run("add schema --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created drizzle.config.ts");

      const schemaPath = path.join(tmpDir, "db", "schema", "khotan.ts");
      expect(fs.existsSync(schemaPath)).toBe(true);

      const drizzleConfig = fs.readFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        "utf-8",
      );
      expect(drizzleConfig).toContain('schema: "./db/schema/*"');
    });

    it("adds the Vercel cron dispatcher", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);
      const result = run("add cron", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("cron dispatcher");
      expect(result.output).toContain(
        "minute-level flow/variant schedules are checked each minute",
      );

      const vercel = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "vercel.json"), "utf-8"),
      ) as { crons: Array<{ path: string; schedule: string }> };
      expect(vercel.crons).toEqual([
        { path: "/api/khotan/cron", schedule: "* * * * *" },
      ]);
    });

    it("appends the Vercel cron dispatcher to existing vercel.json", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "vercel.json"),
        JSON.stringify({ regions: ["syd1"], crons: [] }, null, 2),
      );
      run("init", tmpDir);
      const result = run("add cron", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Updated vercel.json");

      const vercel = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "vercel.json"), "utf-8"),
      ) as { regions: string[]; crons: Array<{ path: string }> };
      expect(vercel.regions).toEqual(["syd1"]);
      expect(vercel.crons).toContainEqual({
        path: "/api/khotan/cron",
        schedule: "* * * * *",
      });
    });

    it("warns when an existing Vercel cron dispatcher may be too sparse", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "vercel.json"),
        JSON.stringify(
          {
            crons: [{ path: "/api/khotan/cron", schedule: "0 * * * *" }],
          },
          null,
          2,
        ),
      );
      run("init", tmpDir);
      const result = run("add cron", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("may delay minute-level flow schedules");
      expect(result.output).toContain(
        "smallest flow/variant schedule granularity",
      );

      const vercel = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "vercel.json"), "utf-8"),
      ) as { crons: Array<{ path: string; schedule: string }> };
      expect(vercel.crons).toEqual([
        { path: "/api/khotan/cron", schedule: "0 * * * *" },
      ]);
    });

    it("prints Drizzle re-export hint when no barrel file exists", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/schema/*" };`,
      );
      run("init", tmpDir);
      const result = run("add schema", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("re-export");
      expect(result.output).toContain("khotan");
    });

    it("auto-updates barrel and drizzle config with --yes", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(
        tmpDir,
        { "drizzle-orm": "^0.35.0" },
        { "drizzle-kit": "^0.25.0" },
      );
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/schema.ts" };`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "db", "index.ts"),
        `export * from "./schema";\n`,
      );
      run("init", tmpDir);
      const result = run("add schema --yes", tmpDir);
      expect(result.exitCode).toBe(0);

      expect(result.output).toContain("Updated");
      expect(result.output).toContain("khotan re-export");

      const barrel = fs.readFileSync(
        path.join(tmpDir, "db", "index.ts"),
        "utf-8",
      );
      expect(barrel).toContain('export * from "./khotan"');

      const drizzleConfig = fs.readFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        "utf-8",
      );
      expect(drizzleConfig).toContain("./db/*.ts");
      expect(drizzleConfig).not.toContain("./db/schema.ts");
    });

    it("skips drizzle config and barrel updates in non-TTY without --yes", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/schema.ts" };`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "db", "index.ts"),
        `export * from "./schema";\n`,
      );
      run("init", tmpDir);
      const result = run("add schema", tmpDir);
      expect(result.exitCode).toBe(0);

      expect(result.output).toContain("points to a single file");
      expect(result.output).toContain("Skipped");

      const barrel = fs.readFileSync(
        path.join(tmpDir, "db", "index.ts"),
        "utf-8",
      );
      expect(barrel).not.toContain("./khotan");

      const drizzleConfig = fs.readFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        "utf-8",
      );
      expect(drizzleConfig).toContain("./db/schema.ts");
    });

    it("skips barrel update when khotan re-export already present", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/*" };`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "db", "index.ts"),
        `export * from "./schema";\nexport * from "./khotan";\n`,
      );
      run("init", tmpDir);
      const result = run("add schema", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("already re-exports khotan");
    });

    it("skips drizzle config update when schema is already a glob", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(
        tmpDir,
        { "drizzle-orm": "^0.35.0" },
        { "drizzle-kit": "^0.25.0" },
      );
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/schema/*" };`,
      );
      run("init", tmpDir);
      const result = run("add schema --yes", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("points to a single file");

      const drizzleConfig = fs.readFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        "utf-8",
      );
      expect(drizzleConfig).toContain("./db/schema/*");
    });

    it("errors for unknown names and lists components and blocks separately", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);
      const result = run("add foobar", tmpDir);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Unknown name "foobar"');
      expect(result.output).toContain("Components:");
      expect(result.output).toContain("Blocks:");
      expect(result.output).toContain("plug");
      expect(result.output).toContain("cache");
      expect(result.output).toContain("config-page-1");
    });

    it("overwrites existing file with --force", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);
      run("add plug", tmpDir);

      const plugPath = path.join(tmpDir, "khotan", "plugs", "plug.ts");
      fs.writeFileSync(plugPath, "// modified by user");

      const result = run("add plug --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created");

      const content = fs.readFileSync(plugPath, "utf-8");
      expect(content).toContain("export class Plug");
    });

    it("preserves existing file when overwrite is declined via non-TTY stdin", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);
      run("add plug", tmpDir);

      const plugPath = path.join(tmpDir, "khotan", "plugs", "plug.ts");
      fs.writeFileSync(plugPath, "// modified by user");

      try {
        execSync(`echo "n" | node ${CLI_PATH} add plug 2>&1`, {
          cwd: tmpDir,
          encoding: "utf-8",
          timeout: 5000,
        });
      } catch {
        // may exit non-zero or timeout — either is acceptable
      }

      const content = fs.readFileSync(plugPath, "utf-8");
      expect(content).toBe("// modified by user");
    });
  });

  describe("flows command", () => {
    const flows = [
      {
        id: "flow-pollinate-products",
        name: "products-inflow",
        type: "inflow",
        plugName: "pollinate",
        enabled: true,
      },
      {
        id: "flow-shopify-products",
        name: "products-inflow",
        type: "inflow",
        plugName: "shopify",
        enabled: true,
      },
      {
        id: "flow-orders",
        name: "orders-inflow",
        type: "inflow",
        plugName: "pollinate",
        enabled: true,
      },
    ];

    async function startServer() {
      let triggerBody: unknown = null;
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && url.pathname === "/api/khotan/plugs") {
          sendJson(res, 200, []);
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/khotan/flows") {
          sendJson(res, 200, flows);
          return;
        }

        if (
          req.method === "POST" &&
          url.pathname === "/api/khotan/flows/flow-pollinate-products/runs"
        ) {
          triggerBody = await readJsonBody(req);
          sendJson(res, 200, {
            id: "run-1",
            flowId: "flow-pollinate-products",
            workflowRunId: "workflow-run-1",
            status: "running",
            runType: "full",
          });
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/api/khotan/flows/flow-pollinate-products/runs"
        ) {
          sendJson(res, 200, [
            {
              id: "run-1",
              flowId: "flow-pollinate-products",
              status: "ok",
            },
          ]);
          return;
        }

        sendJson(res, 404, { error: "not_found" });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as AddressInfo).port;
      return {
        port,
        close: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
        getTriggerBody: () => triggerBody,
      };
    }

    it("lists flows from the running Khotan API", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["flows", "list", "--port", String(api.port)],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          flows: unknown[];
        };
        expect(data.ok).toBe(true);
        expect(data.flows).toHaveLength(3);
      } finally {
        await api.close();
      }
    });

    it("accepts --json on flows list (no unknown-option error)", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["flows", "list", "--json", "--port", String(api.port)],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        expect(result.output).not.toContain("unknown option");
        const data = JSON.parse(result.output) as {
          ok: boolean;
          flows: unknown[];
        };
        expect(data.ok).toBe(true);
        expect(data.flows).toHaveLength(3);
      } finally {
        await api.close();
      }
    });

    it("fails ambiguous trigger names without --plug", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["flows", "trigger", "products-inflow", "--port", String(api.port)],
          tmpDir,
        );
        expect(result.exitCode).toBe(1);
        const data = JSON.parse(result.output) as {
          error: string;
          hint: string;
        };
        expect(data.error).toBe("ambiguous_flow");
        expect(data.hint).toContain("--plug");
      } finally {
        await api.close();
      }
    });

    it("triggers a flow by name and plug", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          [
            "flows",
            "trigger",
            "products-inflow",
            "--plug",
            "pollinate",
            "--run-type",
            "full",
            "--body",
            '{"force":true}',
            "--port",
            String(api.port),
          ],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          action: string;
          run: { id: string; workflowRunId: string };
        };
        expect(data.ok).toBe(true);
        expect(data.action).toBe("trigger");
        expect(data.run.workflowRunId).toBe("workflow-run-1");
        expect(api.getTriggerBody()).toEqual({
          runType: "full",
          body: { force: true },
        });
      } finally {
        await api.close();
      }
    });

    it("lists runs for a selected flow", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          [
            "flows",
            "runs",
            "products-inflow",
            "--plug",
            "pollinate",
            "--port",
            String(api.port),
          ],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          runs: Array<{ id: string }>;
        };
        expect(data.ok).toBe(true);
        expect(data.runs).toEqual([
          { id: "run-1", flowId: "flow-pollinate-products", status: "ok" },
        ]);
      } finally {
        await api.close();
      }
    });
  });

  describe("mappings command", () => {
    async function startServer() {
      let lastLookupBody: unknown = null;
      let lastUpsertBody: unknown = null;
      let lastUpdateBody: unknown = null;

      const resources = [
        {
          id: "resource-customers",
          name: "customers",
          mapping: {
            connectField: "email",
          },
        },
      ];

      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && url.pathname === "/api/khotan/plugs") {
          sendJson(res, 200, []);
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/khotan/flows") {
          sendJson(res, 200, []);
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/khotan/resources") {
          sendJson(res, 200, resources);
          return;
        }

        if (
          req.method === "GET" &&
          url.pathname === "/api/khotan/resources/resource-customers/mappings"
        ) {
          sendJson(res, 200, {
            items: [
              {
                id: "mapping-1",
                resourceId: "resource-customers",
                connectValue: "alice@example.com",
                refs: {
                  shopify: "gid://shopify/Customer/123",
                  cin7: "cust_456",
                },
                metadata: { firstName: "Alice" },
              },
            ],
            page: {
              limit: Number(url.searchParams.get("limit") ?? "20"),
              offset: Number(url.searchParams.get("offset") ?? "0"),
              hasMore: false,
              prevOffset: 0,
              nextOffset: Number(url.searchParams.get("offset") ?? "0") + 1,
              total: 1,
            },
          });
          return;
        }

        if (
          req.method === "POST" &&
          url.pathname === "/api/khotan/mappings/lookup"
        ) {
          lastLookupBody = await readJsonBody(req);
          sendJson(res, 200, {
            id: "mapping-1",
            resourceId: "resource-customers",
            connectValue: "alice@example.com",
            refs: {
              shopify: "gid://shopify/Customer/123",
              cin7: "cust_456",
            },
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/khotan/mappings") {
          lastUpsertBody = await readJsonBody(req);
          sendJson(res, 201, {
            id: "mapping-1",
            resourceId: "resource-customers",
            connectValue: "alice@example.com",
            refs: {
              shopify: "gid://shopify/Customer/123",
            },
            metadata: { firstName: "Alice" },
          });
          return;
        }

        if (
          req.method === "PUT" &&
          url.pathname === "/api/khotan/mappings/mapping-1"
        ) {
          lastUpdateBody = await readJsonBody(req);
          sendJson(res, 200, {
            id: "mapping-1",
            resourceId: "resource-customers",
            connectValue: "alice@example.com",
            refs: {
              shopify: "gid://shopify/Customer/123",
              cin7: "cust_456",
            },
            metadata: { firstName: "Alice", lastName: "Jones" },
          });
          return;
        }

        if (
          req.method === "DELETE" &&
          url.pathname === "/api/khotan/mappings/mapping-1"
        ) {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (
          req.method === "DELETE" &&
          url.pathname === "/api/khotan/mappings/missing"
        ) {
          sendJson(res, 404, { error: "Mapping not found" });
          return;
        }

        sendJson(res, 404, { error: "not_found" });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as AddressInfo).port;
      return {
        port,
        close: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
        getLastLookupBody: () => lastLookupBody,
        getLastUpsertBody: () => lastUpsertBody,
        getLastUpdateBody: () => lastUpdateBody,
      };
    }

    it("lists mappings for one resource with paging metadata", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          [
            "mappings",
            "list",
            "customers",
            "--limit",
            "25",
            "--offset",
            "50",
            "--search",
            "alice@example.com",
            "--port",
            String(api.port),
          ],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          resource: { name: string };
          items: Array<{ connectValue: string }>;
          page: { limit: number; offset: number; total: number };
        };
        expect(data.ok).toBe(true);
        expect(data.resource.name).toBe("customers");
        expect(data.items[0]?.connectValue).toBe("alice@example.com");
        expect(data.page).toMatchObject({ limit: 25, offset: 50, total: 1 });
      } finally {
        await api.close();
      }
    });

    it("looks up a mapping by canonical connect value", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          [
            "mappings",
            "lookup",
            "customers",
            "--connect-value",
            "alice@example.com",
            "--port",
            String(api.port),
          ],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          mapping: { connectValue: string };
        };
        expect(data.ok).toBe(true);
        expect(data.mapping.connectValue).toBe("alice@example.com");
        expect(api.getLastLookupBody()).toEqual({
          resourceId: "resource-customers",
          connectValue: "alice@example.com",
        });
      } finally {
        await api.close();
      }
    });

    it("rejects lookup without a valid mode", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["mappings", "lookup", "customers", "--port", String(api.port)],
          tmpDir,
        );
        expect(result.exitCode).toBe(1);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          error: string;
          hint: string;
        };
        expect(data.ok).toBe(false);
        expect(data.error).toBe("validation_error");
        expect(data.hint).toContain("--connect-value");
      } finally {
        await api.close();
      }
    });

    it("upserts a mapping with refs and metadata JSON", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          [
            "mappings",
            "upsert",
            "customers",
            "--connect-value",
            "alice@example.com",
            "--refs",
            '{"shopify":"gid://shopify/Customer/123"}',
            "--metadata",
            '{"firstName":"Alice"}',
            "--port",
            String(api.port),
          ],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          action: string;
        };
        expect(data.ok).toBe(true);
        expect(data.action).toBe("upsert");
        expect(api.getLastUpsertBody()).toEqual({
          resourceId: "resource-customers",
          connectValue: "alice@example.com",
          refs: { shopify: "gid://shopify/Customer/123" },
          metadata: { firstName: "Alice" },
        });
      } finally {
        await api.close();
      }
    });

    it("rejects invalid JSON for refs before sending the request", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          [
            "mappings",
            "upsert",
            "customers",
            "--connect-value",
            "alice@example.com",
            "--refs",
            "{bad json",
            "--port",
            String(api.port),
          ],
          tmpDir,
        );
        expect(result.exitCode).toBe(1);
        const data = JSON.parse(result.output) as {
          error: string;
          hint: string;
        };
        expect(data.error).toBe("invalid_json");
        expect(data.hint).toContain("--refs");
      } finally {
        await api.close();
      }
    });

    it("updates a mapping by row ID", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          [
            "mappings",
            "update",
            "mapping-1",
            "--resource",
            "customers",
            "--connect-value",
            "alice@example.com",
            "--refs",
            '{"shopify":"gid://shopify/Customer/123","cin7":"cust_456"}',
            "--metadata",
            '{"firstName":"Alice","lastName":"Jones"}',
            "--port",
            String(api.port),
          ],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          action: string;
        };
        expect(data.ok).toBe(true);
        expect(data.action).toBe("update");
        expect(api.getLastUpdateBody()).toEqual({
          resourceId: "resource-customers",
          connectValue: "alice@example.com",
          refs: {
            shopify: "gid://shopify/Customer/123",
            cin7: "cust_456",
          },
          metadata: { firstName: "Alice", lastName: "Jones" },
        });
      } finally {
        await api.close();
      }
    });

    it("deletes a mapping by row ID", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["mappings", "delete", "mapping-1", "--port", String(api.port)],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          action: string;
          id: string;
        };
        expect(data).toEqual({
          ok: true,
          action: "delete",
          id: "mapping-1",
        });
      } finally {
        await api.close();
      }
    });

    it("returns machine-readable connectivity errors", async () => {
      const result = await runAsync(
        ["mappings", "list", "customers", "--port", "65535"],
        tmpDir,
      );
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as {
        ok: boolean;
        error: string;
      };
      expect(data.ok).toBe(false);
      expect(data.error).toBe("connect_failed");
    });

    it("returns a machine-readable error when delete misses", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["mappings", "delete", "missing", "--port", String(api.port)],
          tmpDir,
        );
        expect(result.exitCode).toBe(1);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          error: string;
          hint: string;
        };
        expect(data.ok).toBe(false);
        expect(data.error).toBe("request_failed");
        expect(data.hint).toContain("Mapping not found");
      } finally {
        await api.close();
      }
    });
  });

  describe("plug vars command", () => {
    async function startServer() {
      const requestedPaths: string[] = [];
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "", "http://localhost");
        requestedPaths.push(url.pathname);

        if (url.pathname === "/api/khotan/plugs") {
          sendJson(res, 200, [{ name: "stripe" }]);
          return;
        }
        if (url.pathname === "/api/khotan/variables/stripe") {
          sendJson(res, 200, {
            configured: true,
            fields: [{ name: "apiKey", secret: false }],
            values: { apiKey: "sk_test_123" },
          });
          return;
        }
        sendJson(res, 404, { error: "not_found" });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as AddressInfo).port;
      return {
        port,
        close: () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
        getRequestedPaths: () => requestedPaths,
      };
    }

    // Regression: --port placed on the parent `plug` command (before the `vars`
    // subcommand) was dropped, so the request fell back to port 3000 instead of
    // the supplied port. optsWithGlobals() in the vars action now honors it.
    it("honors --port when supplied on the parent plug command", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["plug", "--port", String(api.port), "vars", "stripe", "show"],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as {
          ok: boolean;
          plugName: string;
          values: Record<string, string>;
        };
        expect(data.ok).toBe(true);
        expect(data.plugName).toBe("stripe");
        expect(data.values.apiKey).toBe("sk_test_123");
        expect(api.getRequestedPaths()).toContain(
          "/api/khotan/variables/stripe",
        );
      } finally {
        await api.close();
      }
    });

    it("honors --port when supplied on the vars subcommand itself", async () => {
      const api = await startServer();
      try {
        const result = await runAsync(
          ["plug", "vars", "stripe", "show", "--port", String(api.port)],
          tmpDir,
        );
        expect(result.exitCode).toBe(0);
        const data = JSON.parse(result.output) as { ok: boolean };
        expect(data.ok).toBe(true);
        expect(api.getRequestedPaths()).toContain(
          "/api/khotan/variables/stripe",
        );
      } finally {
        await api.close();
      }
    });
  });

  describe("workflow integration scaffolding", () => {
    it("appends khotan-data to single-line serverExternalPackages arrays", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "next.config.ts"),
        [
          "const nextConfig = {",
          '  serverExternalPackages: ["sharp",],',
          "};",
          "",
          "export default nextConfig;",
          "",
        ].join("\n"),
      );

      const result = ensureWorkflowNextConfig(tmpDir);
      expect(result.status).toBe("updated");

      const content = fs.readFileSync(
        path.join(tmpDir, "next.config.ts"),
        "utf-8",
      );
      expect(content).toContain(
        'serverExternalPackages: ["sharp", "khotan-data"]',
      );
      expect(content).not.toContain(",,");
    });

    it("appends khotan-data to multiline serverExternalPackages arrays", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "next.config.ts"),
        [
          "const nextConfig = {",
          "  serverExternalPackages: [",
          '    "sharp",',
          "  ],",
          "};",
          "",
          "export default nextConfig;",
          "",
        ].join("\n"),
      );

      const result = ensureWorkflowNextConfig(tmpDir);
      expect(result.status).toBe("updated");

      const content = fs.readFileSync(
        path.join(tmpDir, "next.config.ts"),
        "utf-8",
      );
      expect(content).toContain(
        [
          "serverExternalPackages: [",
          '    "sharp",',
          '    "khotan-data",',
          "  ]",
        ].join("\n"),
      );
      expect(content).not.toContain(",,");
    });

    it("updates existing next.config.ts when adding catch", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(
        tmpDir,
        {
          "drizzle-orm": "^0.35.0",
          workflow: "^4.0.0",
        },
        { "drizzle-kit": "^0.25.0" },
      );
      fs.writeFileSync(
        path.join(tmpDir, "next.config.ts"),
        [
          'import type { NextConfig } from "next";',
          "",
          "const nextConfig: NextConfig = { reactStrictMode: true };",
          "",
          "export default nextConfig;",
          "",
        ].join("\n"),
      );

      run("init", tmpDir);
      const result = run("add catch --yes", tmpDir);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        "Updated next.config.ts with Workflow integration",
      );

      const content = fs.readFileSync(
        path.join(tmpDir, "next.config.ts"),
        "utf-8",
      );
      expect(content).toContain(
        'import { withWorkflow } from "workflow/next";',
      );
      expect(content).toContain('serverExternalPackages: ["khotan-data"]');
      expect(content).toContain("export default withWorkflow(nextConfig);");
      expect(
        fs.existsSync(
          path.join(tmpDir, "khotan", "webhooks", "catch.example.ts"),
        ),
      ).toBe(true);
    });

    it("creates next.config.ts when adding pass to a project without one", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(
        tmpDir,
        {
          "drizzle-orm": "^0.35.0",
          workflow: "^4.0.0",
        },
        { "drizzle-kit": "^0.25.0" },
      );

      run("init", tmpDir);
      const result = run("add pass --yes", tmpDir);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        "Created next.config.ts with Workflow integration",
      );

      const content = fs.readFileSync(
        path.join(tmpDir, "next.config.ts"),
        "utf-8",
      );
      expect(content).toContain(
        'import { withWorkflow } from "workflow/next";',
      );
      expect(content).toContain('serverExternalPackages: ["khotan-data"]');
      expect(content).toContain("export default withWorkflow(nextConfig);");
      expect(
        fs.existsSync(
          path.join(tmpDir, "khotan", "webhooks", "pass.example.ts"),
        ),
      ).toBe(true);
    });
  });

  describe("add hub", () => {
    it("scaffolds hub.tsx in src layout (core files from init)", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "src", "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);
      const result = run("add hub --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created 5 files");

      expect(
        fs.existsSync(
          path.join(tmpDir, "src", "components", "khotan", "hub.tsx"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(tmpDir, "src", "components", "khotan", "wire.tsx"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(tmpDir, "src", "components", "khotan", "date-time.tsx"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, "src", "khotan", "khotan.ts")),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            tmpDir,
            "src",
            "app",
            "api",
            "khotan",
            "[...all]",
            "route.ts",
          ),
        ),
      ).toBe(true);
    });

    it("scaffolds hub.tsx in top-level app layout (core files from init)", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);
      const result = run("add hub --force", tmpDir);
      expect(result.exitCode).toBe(0);

      expect(
        fs.existsSync(path.join(tmpDir, "components", "khotan", "hub.tsx")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, "components", "khotan", "wire.tsx")),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(tmpDir, "components", "khotan", "date-time.tsx"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "khotan", "khotan.ts"))).toBe(
        true,
      );
      expect(
        fs.existsSync(
          path.join(tmpDir, "app", "api", "khotan", "[...all]", "route.ts"),
        ),
      ).toBe(true);
    });

    it("warns when shadcn is not configured", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of ["card", "badge", "table", "switch"]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);
      const result = run("add hub --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("shadcn/ui is required");
      expect(result.output).toContain("components.json");
    });

    it("hub.tsx has no khotan-data imports", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);
      run("add hub --force", tmpDir);

      const hubPath = path.join(tmpDir, "components", "khotan", "hub.tsx");
      const content = fs.readFileSync(hubPath, "utf-8");
      expect(content).not.toContain('from "khotan-data"');
      expect(content).not.toContain("from 'khotan-data'");
    });

    it("shows next steps after scaffolding hub", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);
      const result = run("add hub --force", tmpDir);
      expect(result.output).toContain("Next steps:");
      expect(result.output).toContain("config-page-1");
    });

    it("preserves existing khotan.ts config on hub install", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);

      const khotanTsPath = path.join(tmpDir, "khotan", "khotan.ts");
      fs.writeFileSync(khotanTsPath, 'const MY_PLUGS = "cin7";');

      const result = run("add hub --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("already exists, skipping");

      const content = fs.readFileSync(khotanTsPath, "utf-8");
      expect(content).toBe('const MY_PLUGS = "cin7";');
    });

    it("init creates khotan.ts instance config", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      const result = run("init", tmpDir);
      expect(result.exitCode).toBe(0);

      const configPath = path.join(tmpDir, "khotan", "khotan.ts");
      expect(fs.existsSync(configPath)).toBe(true);
      const content = fs.readFileSync(configPath, "utf-8");
      expect(content).toContain("khotan");
      expect(content).toContain("drizzleAdapter");
    });

    it("route template exposes PATCH method", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);

      const routePath = path.join(
        tmpDir,
        "app",
        "api",
        "khotan",
        "[...all]",
        "route.ts",
      );
      const content = fs.readFileSync(routePath, "utf-8");
      expect(content).toContain("PATCH");
      expect(content).toContain(
        'import { toNextJsHandler } from "khotan-data/factory"',
      );
      expect(content).toContain(
        'import khotanData from "../../../../khotan/khotan"',
      );
      expect(content).toContain(
        "export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(",
      );
      expect(content).not.toContain("khotan-data/next");
      expect(content).not.toContain("@/khotan/khotan");
    });

    it("route template exposes PATCH method with a custom outputDir", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        'export default { outputDir: "lib/custom" };',
      );
      run("init", tmpDir);

      expect(
        fs.existsSync(path.join(tmpDir, "lib", "custom", "khotan.ts")),
      ).toBe(true);

      const routePath = path.join(
        tmpDir,
        "app",
        "api",
        "khotan",
        "[...all]",
        "route.ts",
      );
      const content = fs.readFileSync(routePath, "utf-8");
      expect(content).toContain(
        'import khotanData from "../../../../lib/custom/khotan"',
      );
      expect(content).not.toContain("khotan-data/next");
      expect(content).not.toContain("@/khotan/khotan");
    });

    it("hub.tsx uses PATCH for flow toggles", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);
      run("add hub --force", tmpDir);

      const hubPath = path.join(tmpDir, "components", "khotan", "hub.tsx");
      const content = fs.readFileSync(hubPath, "utf-8");
      expect(content).toContain('"PATCH"');
      expect(content).toContain("/api/khotan/flows");
      expect(content).toContain("effectiveSchedule");
      expect(content).toContain("flow.effectiveSchedule ?? flow.schedule");
      expect(content).not.toContain("/api/khotan/syncs");
      expect(content).not.toContain('method: "PUT"');
    });
  });

  describe("add logs", () => {
    it("scaffolds local timezone formatter with log tables", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of ["card", "table", "badge", "button"]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }

      run("init", tmpDir);
      const result = run("add logs --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created 5 files");

      const dateTimePath = path.join(
        tmpDir,
        "components",
        "khotan",
        "date-time.tsx",
      );
      const runsTablePath = path.join(
        tmpDir,
        "components",
        "khotan",
        "runs-table.tsx",
      );
      const webhookEventsPath = path.join(
        tmpDir,
        "components",
        "khotan",
        "webhook-events-table.tsx",
      );

      expect(fs.existsSync(dateTimePath)).toBe(true);
      expect(fs.readFileSync(runsTablePath, "utf-8")).toContain(
        'from "./date-time"',
      );
      expect(fs.readFileSync(webhookEventsPath, "utf-8")).toContain(
        'from "./date-time"',
      );
    });
  });

  describe("add config-page-1 (block)", () => {
    function preScaffoldHub(dir: string, srcLayout: boolean): void {
      const hubDir = srcLayout
        ? path.join(dir, "src", "components", "khotan")
        : path.join(dir, "components", "khotan");
      fs.mkdirSync(hubDir, { recursive: true });
      fs.writeFileSync(
        path.join(hubDir, "hub.tsx"),
        "export function KhotanHub() {}",
      );
      fs.writeFileSync(
        path.join(hubDir, "wire.tsx"),
        "export function WirePanel() {}",
      );
      fs.writeFileSync(path.join(hubDir, "api-state.tsx"), "export {}");
      fs.writeFileSync(path.join(hubDir, "date-time.tsx"), "export {}");
      fs.writeFileSync(path.join(hubDir, "var-panel.tsx"), "export {}");
    }

    it("scaffolds config/page.tsx in src layout", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      preScaffoldHub(tmpDir, true);
      run("init", tmpDir);
      const result = run("add config-page-1 --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created 1 files");

      const pagePath = path.join(tmpDir, "src", "app", "config", "page.tsx");
      expect(fs.existsSync(pagePath)).toBe(true);

      const content = fs.readFileSync(pagePath, "utf-8");
      expect(content).toContain("KhotanHub");
      expect(content).toContain("@/components/khotan/hub");
    });

    it("scaffolds config/page.tsx in top-level app layout", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      preScaffoldHub(tmpDir, false);
      run("init", tmpDir);
      const result = run("add config-page-1 --force", tmpDir);
      expect(result.exitCode).toBe(0);

      const pagePath = path.join(tmpDir, "app", "config", "page.tsx");
      expect(fs.existsSync(pagePath)).toBe(true);
    });

    it("page has no khotan-data imports", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      preScaffoldHub(tmpDir, false);
      run("init", tmpDir);
      run("add config-page-1 --force", tmpDir);

      const pagePath = path.join(tmpDir, "app", "config", "page.tsx");
      const content = fs.readFileSync(pagePath, "utf-8");
      expect(content).not.toContain('from "khotan-data"');
      expect(content).not.toContain("from 'khotan-data'");
    });

    it("auto-adds hub when not present", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }
      run("init", tmpDir);
      const result = run("add config-page-1 --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Adding required component: hub");
      expect(
        fs.existsSync(path.join(tmpDir, "components", "khotan", "hub.tsx")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, "app", "config", "page.tsx")),
      ).toBe(true);
    });
  });

  describe("add graph (block)", () => {
    it("scaffolds topology-canvas and graph/page.tsx in src layout", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      writePkgJson(tmpDir, { "@xyflow/react": "^12.8.5" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "src", "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of ["card", "badge"]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }

      run("init", tmpDir);
      const result = run("add graph --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created 4 files");

      const componentPath = path.join(
        tmpDir,
        "src",
        "components",
        "khotan",
        "topology-canvas.tsx",
      );
      const dateTimePath = path.join(
        tmpDir,
        "src",
        "components",
        "khotan",
        "date-time.tsx",
      );
      const pagePath = path.join(tmpDir, "src", "app", "graph", "page.tsx");

      expect(fs.existsSync(componentPath)).toBe(true);
      expect(fs.existsSync(dateTimePath)).toBe(true);
      expect(fs.existsSync(pagePath)).toBe(true);

      const component = fs.readFileSync(componentPath, "utf-8");
      const page = fs.readFileSync(pagePath, "utf-8");

      expect(component).toContain("@xyflow/react");
      expect(component).toContain("/api/khotan/runs?limit=100");
      expect(component).toContain("<details");
      expect(component).toContain("Webhook handlers");
      expect(component).toContain("Reset");
      expect(page).toContain("KhotanTopologyCanvas");
      expect(page).toContain("@/components/khotan/topology-canvas");
      expect(page).not.toContain("Graph Block");
    });

    it("scaffolds topology-canvas and graph/page.tsx in top-level app layout", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "@xyflow/react": "^12.8.5" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const c of ["card", "badge"]) {
        fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
      }

      run("init", tmpDir);
      const result = run("add graph --force", tmpDir);
      expect(result.exitCode).toBe(0);

      expect(
        fs.existsSync(
          path.join(tmpDir, "components", "khotan", "topology-canvas.tsx"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(tmpDir, "components", "khotan", "date-time.tsx"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "app", "graph", "page.tsx"))).toBe(
        true,
      );
    });
  });

  describe("add dependency checks", () => {
    it("shows missing npm packages when package.json has no drizzle-orm", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir);
      run("init", tmpDir);
      const result = run("add schema", tmpDir);
      expect(result.output).toContain("Missing npm packages");
      expect(result.output).toContain("drizzle-orm");
      expect(result.output).toContain("drizzle-kit");
      expect(result.output).toContain("Skipping dependency install");
    });

    it("does not show missing packages when drizzle packages are present", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({
          dependencies: { "drizzle-orm": "^0.35.0" },
          devDependencies: { "drizzle-kit": "^0.25.0" },
        }),
      );
      run("init", tmpDir);
      const result = run("add schema", tmpDir);
      expect(result.output).not.toContain("Missing npm packages");
    });

    it("shows missing shadcn components for hub", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      run("init", tmpDir);
      const result = run("add hub --force", tmpDir);
      expect(result.output).toContain("Missing shadcn components");
      expect(result.output).toContain("Skipping dependency install");
    });

    it("does not show missing shadcn components when all exist", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({
          dependencies: { "drizzle-orm": "^0.35.0" },
          devDependencies: { "drizzle-kit": "^0.25.0" },
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      const uiDir = path.join(tmpDir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const comp of [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ]) {
        fs.writeFileSync(path.join(uiDir, `${comp}.tsx`), "");
      }
      run("init", tmpDir);
      const result = run("add hub --force", tmpDir);
      expect(result.output).not.toContain("Missing shadcn components");
      expect(result.output).not.toContain("Missing npm packages");
    });

    it("plug has no dependency prompts when zod is installed", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { zod: "^3.0.0" });
      run("init", tmpDir);
      const result = run("add plug", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("Missing");
      expect(result.output).toContain("Created");
    });

    it("scaffolds even when dependency install is skipped", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/*" };`,
      );
      run("init", tmpDir);
      const result = run("add schema --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Skipping dependency install");
      expect(result.output).toContain("Created");
    });

    it("warns when dependency install is declined in non-TTY", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ dependencies: {} }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/*" };`,
      );
      run("init", tmpDir);
      const result = run("add schema", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Skipping dependency install");
      expect(result.output).toContain("Created");
    });
  });

  describe("init --full", () => {
    function setupFullProject(
      dir: string,
      opts: {
        deps?: Record<string, string>;
        devDeps?: Record<string, string>;
        componentsJson?: boolean;
        shadcnComponents?: boolean;
        existingConfig?: string;
        lockfile?: string;
      } = {},
    ): void {
      fs.mkdirSync(path.join(dir, "app"), { recursive: true });
      writePkgJson(dir, opts.deps ?? {}, opts.devDeps ?? {});
      if (opts.componentsJson) {
        fs.writeFileSync(path.join(dir, "components.json"), JSON.stringify({}));
      }
      if (opts.shadcnComponents) {
        const uiDir = path.join(dir, "components", "ui");
        fs.mkdirSync(uiDir, { recursive: true });
        for (const c of ["card", "badge", "table", "switch"]) {
          fs.writeFileSync(path.join(uiDir, `${c}.tsx`), "");
        }
      }
      if (opts.existingConfig) {
        fs.writeFileSync(
          path.join(dir, "khotan.config.ts"),
          opts.existingConfig,
        );
      }
      if (opts.lockfile) {
        fs.writeFileSync(path.join(dir, opts.lockfile), "");
      }
    }

    const allDeps = { "drizzle-orm": "^0.35.0", postgres: "^3.0.0" };
    const allDevDeps = { "drizzle-kit": "^0.25.0" };

    it("shows setup summary", () => {
      setupFullProject(tmpDir, {
        deps: allDeps,
        devDeps: allDevDeps,
        componentsJson: true,
        shadcnComponents: true,
      });
      const result = run("init --full", tmpDir);
      expect(result.output).toContain("Running full khotan setup");
      expect(result.output).toContain("Setup Summary");
    });

    it("creates khotan.config.ts during full setup", () => {
      setupFullProject(tmpDir, {
        deps: allDeps,
        devDeps: allDevDeps,
        componentsJson: true,
        shadcnComponents: true,
      });
      const result = run("init --full", tmpDir);
      expect(result.output).toContain("khotan.config.ts");
      expect(fs.existsSync(path.join(tmpDir, "khotan.config.ts"))).toBe(true);
    });

    it("skips drizzle install when packages already present", () => {
      setupFullProject(tmpDir, {
        deps: allDeps,
        devDeps: allDevDeps,
        componentsJson: true,
        shadcnComponents: true,
      });
      const result = run("init --full", tmpDir);
      expect(result.output).toContain("already installed");
    });

    it("skips shadcn init when components.json exists", () => {
      setupFullProject(tmpDir, {
        deps: allDeps,
        devDeps: allDevDeps,
        componentsJson: true,
        shadcnComponents: true,
      });
      const result = run("init --full", tmpDir);
      expect(result.output).toContain("already configured");
    });

    it("skips config creation when khotan.config.ts already exists", () => {
      setupFullProject(tmpDir, {
        deps: allDeps,
        devDeps: allDevDeps,
        componentsJson: true,
        shadcnComponents: true,
        existingConfig: "existing config",
      });
      const result = run("init --full", tmpDir);
      expect(result.output).toContain("already exists");
      const content = fs.readFileSync(
        path.join(tmpDir, "khotan.config.ts"),
        "utf-8",
      );
      expect(content).toBe("existing config");
    });

    it(
      "continues with remaining steps when a step fails",
      { timeout: 60_000 },
      () => {
        setupFullProject(tmpDir, {
          componentsJson: true,
          shadcnComponents: true,
        });
        const result = run("init --full", tmpDir, 45_000);
        expect(result.output).toContain("Setup Summary");
        expect(fs.existsSync(path.join(tmpDir, "khotan.config.ts"))).toBe(true);
      },
    );

    it("detects package manager from lockfile", () => {
      setupFullProject(tmpDir, {
        deps: allDeps,
        devDeps: allDevDeps,
        componentsJson: true,
        shadcnComponents: true,
        lockfile: "pnpm-lock.yaml",
      });
      const result = run("init --full", tmpDir);
      expect(result.output).toContain("Detected package manager: pnpm");
    });
  });

  describe("generate", () => {
    it("scaffolds khotan.ts schema at detected Drizzle directory", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/*" };`,
      );
      run("init", tmpDir);
      const result = run("generate", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Detected Drizzle schema directory");

      const schemaPath = path.join(tmpDir, "db", "khotan.ts");
      expect(fs.existsSync(schemaPath)).toBe(true);
      const content = fs.readFileSync(schemaPath, "utf-8");
      expect(content).toContain("khotan_plugs");
    });

    it("updates single-file drizzle config to glob", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/schema.ts" };`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "db", "index.ts"),
        `export * from "./schema";\n`,
      );
      run("init", tmpDir);
      const result = run("generate", tmpDir);
      expect(result.exitCode).toBe(0);

      const drizzleConfig = fs.readFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        "utf-8",
      );
      expect(drizzleConfig).toContain("./db/*.ts");
    });

    it("appends khotan re-export to barrel file", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/*" };`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "db", "index.ts"),
        `export * from "./schema";\n`,
      );
      run("init", tmpDir);
      const result = run("generate", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("khotan re-export");

      const barrel = fs.readFileSync(
        path.join(tmpDir, "db", "index.ts"),
        "utf-8",
      );
      expect(barrel).toContain('export * from "./khotan"');
    });

    it("skips barrel update when khotan re-export already present", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0" });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/*" };`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "db", "index.ts"),
        `export * from "./schema";\nexport * from "./khotan";\n`,
      );
      run("init", tmpDir);
      const result = run("generate", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("already re-exports khotan");
    });

    it("runs init automatically if no config exists", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "db"), { recursive: true });
      writePkgJson(tmpDir, {
        "khotan-data": "^0.0.1",
        "drizzle-orm": "^0.35.0",
      });
      fs.writeFileSync(
        path.join(tmpDir, "drizzle.config.ts"),
        `export default { schema: "./db/*" };`,
      );
      const result = run("generate", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Running init");
      expect(fs.existsSync(path.join(tmpDir, "khotan.config.ts"))).toBe(true);
    });
  });

  describe("help", () => {
    it("shows usage when run with no args", () => {
      const result = run("", tmpDir);
      expect(result.output).toContain("Usage:");
      expect(result.output).toContain("init");
      expect(result.output).toContain("add");
      expect(result.output).toContain("generate");
      expect(result.output).toContain("migrate");
      expect(result.output).toContain("wire");
      expect(result.output).toContain("mappings");
    });
  });

  describe("add wire", () => {
    it("wire appears in component listing and has correct metadata", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      run("init", tmpDir);
      const result = run("add foobar", tmpDir);
      expect(result.output).toContain("wire");
    });

    it("wire.ts template contains wire factory function and commented example", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0", zod: "^3.0.0" });
      run("init", tmpDir);

      // Pre-scaffold plug and schema so wire doesn't trigger requires prompt
      const plugDir = path.join(tmpDir, "khotan", "plugs");
      fs.mkdirSync(plugDir, { recursive: true });
      fs.writeFileSync(path.join(plugDir, "plug.ts"), "export class Plug {}");
      fs.writeFileSync(path.join(tmpDir, "khotan", "khotan.ts"), "// schema");

      const result = run("add wire --force --without-ui", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created");

      const wirePath = path.join(tmpDir, "khotan", "wires", "wire.ts");
      expect(fs.existsSync(wirePath)).toBe(true);

      const content = fs.readFileSync(wirePath, "utf-8");
      // The scaffold re-exports the real builder/types from khotan-data
      // instead of redeclaring them locally (PR 10).
      expect(content).toContain("export { wire");
      expect(content).toContain('from "khotan-data/factory"');
      expect(content).toContain("// Usage Example");
    });

    it("wire requires plug and schema", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, { "drizzle-orm": "^0.35.0", zod: "^3.0.0" });
      run("init", tmpDir);

      // Don't pre-scaffold plug/schema — wire should offer to add them
      const result = run("add wire --force --without-ui", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Adding required component: plug");
    });
  });

  describe("add mapping-browser", () => {
    function seedUi(dir: string, src = false) {
      const uiDir = src
        ? path.join(dir, "src", "components", "ui")
        : path.join(dir, "components", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      for (const component of ["card", "table", "button", "input", "label"]) {
        fs.writeFileSync(path.join(uiDir, `${component}.tsx`), "");
      }
    }

    it("scaffolds the reusable mapping browser component", () => {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      writePkgJson(tmpDir, {});
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      seedUi(tmpDir);
      run("init", tmpDir);

      const result = run("add mapping-browser --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Created 2 files");

      const componentPath = path.join(
        tmpDir,
        "components",
        "khotan",
        "mapping-browser.tsx",
      );
      expect(fs.existsSync(componentPath)).toBe(true);
      const content = fs.readFileSync(componentPath, "utf-8");
      expect(content).toContain("export function KhotanMappingBrowser");
      expect(content).toContain("/api/khotan/resources");
      expect(content).not.toContain('from "khotan-data"');
      expect(content).not.toContain("from 'khotan-data'");
    });

    it("scaffolds mappings-page-1 and auto-adds mapping-browser", () => {
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      writePkgJson(tmpDir, {});
      fs.writeFileSync(
        path.join(tmpDir, "components.json"),
        JSON.stringify({}),
      );
      seedUi(tmpDir, true);
      run("init", tmpDir);

      const result = run("add mappings-page-1 --force", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        "Adding required component: mapping-browser",
      );

      const componentPath = path.join(
        tmpDir,
        "src",
        "components",
        "khotan",
        "mapping-browser.tsx",
      );
      const pagePath = path.join(tmpDir, "src", "app", "mappings", "page.tsx");
      expect(fs.existsSync(componentPath)).toBe(true);
      expect(fs.existsSync(pagePath)).toBe(true);
      expect(fs.readFileSync(pagePath, "utf-8")).toContain(
        "KhotanMappingBrowser",
      );
    });
  });
});
