import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveDrizzleSchemaDir,
  detectSingleFileSchema,
  updateDrizzleConfigSchema,
  defaultDrizzleSchemaDir,
  scaffoldDrizzleConfig,
  syncDrizzleConfig,
} from "./drizzle-detect.js";

describe("resolveDrizzleSchemaDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-drizzle-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when drizzle.config.ts does not exist", () => {
    expect(resolveDrizzleSchemaDir(tmpDir)).toBeNull();
  });

  it('detects directory from string path: "./src/db/schema"', () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./src/db/schema" };`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("src/db/schema");
  });

  it('detects directory from file path: "./src/db/schema.ts"', () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./src/db/schema.ts" };`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("src/db");
  });

  it('detects directory from glob: "./src/db/schema/*"', () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./src/db/schema/*" };`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("src/db/schema");
  });

  it('detects directory from glob with extension: "./db/schema/*.ts"', () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./db/schema/*.ts" };`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("db/schema");
  });

  it("handles single-quoted strings", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: './src/db/schema' };`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("src/db/schema");
  });

  it("handles backtick strings", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      "export default { schema: `./src/db/schema` };",
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("src/db/schema");
  });

  it("returns null when schema property is not a string", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: ["./src/db/schema/*"] };`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBeNull();
  });

  it("returns null for unparseable config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      "this is not valid ts but has no schema property",
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBeNull();
  });

  it("handles config with defineConfig wrapper", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ schema: "./drizzle/schema.ts" });`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("drizzle");
  });

  it("handles path without leading ./", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "src/db/schema" };`,
    );
    expect(resolveDrizzleSchemaDir(tmpDir)).toBe("src/db/schema");
  });
});

describe("detectSingleFileSchema", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-drizzle-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects single file schema and returns glob replacement", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./src/db/schema.ts" };`,
    );
    const result = detectSingleFileSchema(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.currentValue).toBe("./src/db/schema.ts");
    expect(result!.globValue).toBe("./src/db/*.ts");
  });

  it("returns null for glob schema", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./src/db/schema/*" };`,
    );
    expect(detectSingleFileSchema(tmpDir)).toBeNull();
  });

  it("returns null for directory schema", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./src/db/schema" };`,
    );
    expect(detectSingleFileSchema(tmpDir)).toBeNull();
  });

  it("returns null when no config exists", () => {
    expect(detectSingleFileSchema(tmpDir)).toBeNull();
  });

  it("preserves ./ prefix in glob value", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "./db/schema.ts" };`,
    );
    const result = detectSingleFileSchema(tmpDir);
    expect(result!.globValue).toBe("./db/*.ts");
  });

  it("handles path without ./ prefix", () => {
    fs.writeFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      `export default { schema: "src/db/schema.ts" };`,
    );
    const result = detectSingleFileSchema(tmpDir);
    expect(result!.currentValue).toBe("src/db/schema.ts");
    expect(result!.globValue).toBe("src/db/*.ts");
  });
});

describe("updateDrizzleConfigSchema", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-drizzle-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replaces single file schema with glob and returns true", () => {
    const configPath = path.join(tmpDir, "drizzle.config.ts");
    fs.writeFileSync(
      configPath,
      `import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ schema: "./src/db/schema.ts", out: "./drizzle" });`,
    );
    const replaced = updateDrizzleConfigSchema(
      configPath,
      "./src/db/schema.ts",
      "./src/db/*",
    );
    expect(replaced).toBe(true);
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain('"./src/db/*"');
    expect(content).not.toContain("schema.ts");
    expect(content).toContain("drizzle-kit");
    expect(content).toContain("./drizzle");
  });

  it("returns false when pattern is not found", () => {
    const configPath = path.join(tmpDir, "drizzle.config.ts");
    fs.writeFileSync(configPath, `export default { schema: "./src/db/*" };`);
    const replaced = updateDrizzleConfigSchema(
      configPath,
      "./src/db/schema.ts",
      "./src/db/*",
    );
    expect(replaced).toBe(false);
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain('"./src/db/*"');
  });

  it("preserves quote style", () => {
    const configPath = path.join(tmpDir, "drizzle.config.ts");
    fs.writeFileSync(
      configPath,
      `export default { schema: './db/schema.ts' };`,
    );
    updateDrizzleConfigSchema(configPath, "./db/schema.ts", "./db/*");
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain("'./db/*'");
  });
});

describe("scaffoldDrizzleConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-drizzle-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to src/db/schema for src app projects", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
    expect(defaultDrizzleSchemaDir(tmpDir)).toBe("src/db/schema");
  });

  it("creates a minimal drizzle config without @next/env", () => {
    const result = scaffoldDrizzleConfig(tmpDir, "db/schema");
    expect(result.status).toBe("created");

    const content = fs.readFileSync(
      path.join(tmpDir, "drizzle.config.ts"),
      "utf-8",
    );
    expect(content).toContain('import { defineConfig } from "drizzle-kit"');
    expect(content).toContain('schema: "./db/schema/*"');
    expect(content).toContain("process.env.DATABASE_URL");
    expect(content).not.toContain("@next/env");
  });

  it("skips an existing drizzle config", () => {
    fs.writeFileSync(path.join(tmpDir, "drizzle.config.ts"), "existing");
    const result = scaffoldDrizzleConfig(tmpDir, "db/schema");
    expect(result.status).toBe("skipped");
    expect(
      fs.readFileSync(path.join(tmpDir, "drizzle.config.ts"), "utf-8"),
    ).toBe("existing");
  });
});

describe("syncDrizzleConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-drizzle-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a config with schema and out relative to the config file", () => {
    const result = syncDrizzleConfig(tmpDir, {
      configPath: "packages/databases/pipeline/drizzle.config.ts",
      schemaPath: "packages/databases/pipeline/src/index.ts",
      migrationsOutput: "packages/databases/pipeline/migrations",
    });

    expect(result.status).toBe("created");
    expect(result.schemaValue).toBe("./src/index.ts");
    expect(result.outValue).toBe("./migrations");

    const content = fs.readFileSync(result.path, "utf-8");
    expect(content).toContain('schema: "./src/index.ts"');
    expect(content).toContain('out: "./migrations"');
    expect(content).toContain('import { defineConfig } from "drizzle-kit"');
  });

  it("updates an existing config without rewriting unrelated fields", () => {
    const configPath = path.join(
      tmpDir,
      "packages",
      "databases",
      "pipeline",
      "drizzle.config.ts",
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        `export default {`,
        `  dialect: "postgresql",`,
        `  schema: "./src/schema.ts",`,
        `  out: "./drizzle",`,
        `  strict: true,`,
        `};`,
        ``,
      ].join("\n"),
    );

    const result = syncDrizzleConfig(tmpDir, {
      configPath: "packages/databases/pipeline/drizzle.config.ts",
      schemaPath: "packages/databases/pipeline/src/index.ts",
      migrationsOutput: "packages/databases/pipeline/migrations",
    });

    expect(result.status).toBe("updated");
    expect(result.updatedFields).toEqual(["schema", "out"]);

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain('schema: "./src/index.ts"');
    expect(content).toContain('out: "./migrations"');
    expect(content).toContain("strict: true");
  });

  it("returns unsupported for an existing config without a string schema", () => {
    const configPath = path.join(tmpDir, "drizzle.config.ts");
    fs.writeFileSync(configPath, `export default { schema: ["./src/db/*"] };`);

    const result = syncDrizzleConfig(tmpDir, {
      configPath: "drizzle.config.ts",
      schemaPath: "src/db/index.ts",
    });

    expect(result.status).toBe("unsupported");
    expect(fs.readFileSync(configPath, "utf-8")).toContain(
      'schema: ["./src/db/*"]',
    );
  });
});
