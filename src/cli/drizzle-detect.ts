import fs from "node:fs";
import path from "node:path";

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function withDotPrefix(value: string): string {
  const normalized = toPosixPath(value);
  if (normalized.startsWith(".") || path.isAbsolute(normalized)) {
    return normalized;
  }
  return `./${normalized}`;
}

function resolveConfigPath(projectRoot: string, configPath?: string): string {
  return path.resolve(projectRoot, configPath ?? "drizzle.config.ts");
}

function readDrizzleConfig(
  projectRoot: string,
  configPath?: string,
): {
  content: string;
  configPath: string;
} | null {
  const resolvedConfigPath = resolveConfigPath(projectRoot, configPath);

  if (!fs.existsSync(resolvedConfigPath)) {
    return null;
  }

  try {
    return {
      content: fs.readFileSync(resolvedConfigPath, "utf-8"),
      configPath: resolvedConfigPath,
    };
  } catch {
    return null;
  }
}

export interface ScaffoldDrizzleConfigResult {
  status: "created" | "skipped";
  path: string;
  schemaDir: string;
}

export function defaultDrizzleSchemaDir(projectRoot: string): string {
  return fs.existsSync(path.join(projectRoot, "src", "app"))
    ? "src/db/schema"
    : "db/schema";
}

export function scaffoldDrizzleConfig(
  projectRoot: string,
  schemaDir = defaultDrizzleSchemaDir(projectRoot),
): ScaffoldDrizzleConfigResult {
  const configPath = resolveConfigPath(projectRoot);
  if (fs.existsSync(configPath)) {
    return { status: "skipped", path: configPath, schemaDir };
  }

  const content =
    `import { defineConfig } from "drizzle-kit";\n` +
    `\n` +
    `export default defineConfig({\n` +
    `  dialect: "postgresql",\n` +
    `  schema: "./${schemaDir}/*",\n` +
    `  out: "./drizzle",\n` +
    `  dbCredentials: {\n` +
    `    url: process.env.DATABASE_URL!,\n` +
    `  },\n` +
    `});\n`;

  fs.writeFileSync(configPath, content, "utf-8");
  return { status: "created", path: configPath, schemaDir };
}

function parseSchemaValue(content: string): string | null {
  const schemaMatch = /schema:\s*["'`]([^"'`]+)["'`]/.exec(content);
  return schemaMatch?.[1] ?? null;
}

function pathToConfigValue(configPath: string, targetPath: string): string {
  return withDotPrefix(path.relative(path.dirname(configPath), targetPath));
}

function createDrizzleConfigContent(
  schemaValue: string,
  outValue: string,
): string {
  return (
    `import { defineConfig } from "drizzle-kit";\n` +
    `\n` +
    `export default defineConfig({\n` +
    `  dialect: "postgresql",\n` +
    `  schema: "${schemaValue}",\n` +
    `  out: "${outValue}",\n` +
    `  dbCredentials: {\n` +
    `    url: process.env.DATABASE_URL!,\n` +
    `  },\n` +
    `});\n`
  );
}

function replaceStringProperty(
  content: string,
  property: "schema" | "out",
  newValue: string,
): { content: string; found: boolean; changed: boolean } {
  const pattern = new RegExp(`(${property}:\\s*)(["'\`])([^"'\`]+)\\2`);
  const match = pattern.exec(content);
  if (!match) {
    return { content, found: false, changed: false };
  }

  const oldValue = match[3];
  if (oldValue === newValue) {
    return { content, found: true, changed: false };
  }

  return {
    content: content.replace(pattern, `$1$2${newValue}$2`),
    found: true,
    changed: true,
  };
}

function insertOutAfterSchema(
  content: string,
  outValue: string,
): { content: string; inserted: boolean } {
  const pattern = /(schema:\s*["'`][^"'`]+["'`]\s*,?)/;
  if (!pattern.test(content)) {
    return { content, inserted: false };
  }

  return {
    content: content.replace(pattern, (match) => {
      const schemaProperty = match.trimEnd().endsWith(",")
        ? match.trimEnd()
        : `${match.trimEnd()},`;
      return `${schemaProperty}\n  out: "${outValue}",`;
    }),
    inserted: true,
  };
}

export interface SyncDrizzleConfigResult {
  status: "created" | "updated" | "unchanged" | "unsupported";
  path: string;
  schemaValue: string;
  outValue: string | null;
  updatedFields: string[];
}

export function syncDrizzleConfig(
  projectRoot: string,
  opts: {
    configPath: string;
    schemaPath: string;
    migrationsOutput?: string | undefined;
  },
): SyncDrizzleConfigResult {
  const configPath = resolveConfigPath(projectRoot, opts.configPath);
  const schemaPath = path.resolve(projectRoot, opts.schemaPath);
  const schemaValue = pathToConfigValue(configPath, schemaPath);
  const outValue = opts.migrationsOutput
    ? pathToConfigValue(
        configPath,
        path.resolve(projectRoot, opts.migrationsOutput),
      )
    : null;

  if (!fs.existsSync(configPath)) {
    const defaultOutValue = outValue ?? "./drizzle";
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      createDrizzleConfigContent(schemaValue, defaultOutValue),
      "utf-8",
    );
    return {
      status: "created",
      path: configPath,
      schemaValue,
      outValue: defaultOutValue,
      updatedFields: ["schema", "out"],
    };
  }

  const original = fs.readFileSync(configPath, "utf-8");
  const schemaUpdate = replaceStringProperty(original, "schema", schemaValue);
  if (!schemaUpdate.found) {
    return {
      status: "unsupported",
      path: configPath,
      schemaValue,
      outValue,
      updatedFields: [],
    };
  }

  let content = schemaUpdate.content;
  const updatedFields: string[] = [];
  if (schemaUpdate.changed) updatedFields.push("schema");

  if (outValue) {
    const outUpdate = replaceStringProperty(content, "out", outValue);
    if (outUpdate.found) {
      content = outUpdate.content;
      if (outUpdate.changed) updatedFields.push("out");
    } else {
      const inserted = insertOutAfterSchema(content, outValue);
      content = inserted.content;
      if (inserted.inserted) updatedFields.push("out");
    }
  }

  if (updatedFields.length === 0) {
    return {
      status: "unchanged",
      path: configPath,
      schemaValue,
      outValue,
      updatedFields,
    };
  }

  fs.writeFileSync(configPath, content, "utf-8");
  return {
    status: "updated",
    path: configPath,
    schemaValue,
    outValue,
    updatedFields,
  };
}

/**
 * Attempt to resolve the Drizzle schema directory from drizzle.config.ts.
 * Returns the directory path relative to the project root, or null if detection fails.
 */
export function resolveDrizzleSchemaDir(
  projectRoot: string,
  opts: { configPath?: string | undefined } = {},
): string | null {
  const config = readDrizzleConfig(projectRoot, opts.configPath);
  if (!config) return null;

  const schemaValue = parseSchemaValue(config.content);
  if (!schemaValue) return null;

  const normalized = schemaValue.replace(/^\.\//, "");

  let schemaPath: string;
  if (normalized.includes("*")) {
    schemaPath = normalized.replace(/\/\*.*$/, "");
  } else if (/\.\w+$/.test(normalized)) {
    schemaPath = path.dirname(normalized);
  } else {
    schemaPath = normalized;
  }

  return toPosixPath(
    path.relative(
      projectRoot,
      path.resolve(path.dirname(config.configPath), schemaPath),
    ),
  );
}

/**
 * Check if drizzle.config.ts schema points to a single file (not a glob or directory).
 * Returns the glob replacement value and config path, or null if no update is needed.
 */
export function detectSingleFileSchema(
  projectRoot: string,
  opts: { configPath?: string | undefined } = {},
): {
  configPath: string;
  currentValue: string;
  globValue: string;
} | null {
  const config = readDrizzleConfig(projectRoot, opts.configPath);
  if (!config) return null;

  const schemaValue = parseSchemaValue(config.content);
  if (!schemaValue) return null;

  const normalized = schemaValue.replace(/^\.\//, "");

  if (normalized.includes("*")) return null;
  if (!/\.\w+$/.test(normalized)) return null;

  const dir = path.dirname(normalized);
  const prefix = schemaValue.startsWith("./") ? "./" : "";
  return {
    configPath: config.configPath,
    currentValue: schemaValue,
    globValue: `${prefix}${dir}/*.ts`,
  };
}

/**
 * Rewrite the schema value in drizzle.config.ts.
 * Returns true if the replacement was applied, false if the pattern was not
 * found (avoids writing the file back unchanged and claiming success).
 */
export function updateDrizzleConfigSchema(
  configPath: string,
  oldValue: string,
  newValue: string,
): boolean {
  const content = fs.readFileSync(configPath, "utf-8");
  const pattern = new RegExp(
    `(schema:\\s*)(["'\`])${oldValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\2`,
  );

  if (!pattern.test(content)) {
    return false;
  }

  const updated = content.replace(pattern, `$1$2${newValue}$2`);
  fs.writeFileSync(configPath, updated, "utf-8");
  return true;
}
