import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveOutputDir } from "./cli-api.js";
import { resolveDrizzleSchemaDir } from "./drizzle-detect.js";
import {
  checkKhotanGeneratedSchemaSource,
  formatKhotanRuntimeSchemaCheck,
  getKhotanRuntimeMigrationStatements,
  KHOTAN_RUNTIME_SCHEMA_VERSION,
  loadKhotanRuntimeDatabaseState,
  type KhotanRuntimeDatabaseState,
  type KhotanRuntimeSchemaCheck,
} from "../factory/runtime-schema.js";

interface PostgresClient {
  unsafe(query: string): Promise<unknown>;
  end(): Promise<void>;
}

type PostgresFactory = (
  url: string,
  options: { max: number; prepare: boolean },
) => PostgresClient;

export interface GeneratedSchemaCheckResult {
  path: string;
  relativePath: string;
  exists: boolean;
  check: KhotanRuntimeSchemaCheck;
}

export function resolveGeneratedSchemaPath(cwd: string): string {
  const schemaDir = resolveDrizzleSchemaDir(cwd) ?? resolveOutputDir(cwd);
  return path.resolve(cwd, schemaDir, "khotan.ts");
}

export function checkGeneratedSchemaFile(
  cwd: string,
): GeneratedSchemaCheckResult {
  const schemaPath = resolveGeneratedSchemaPath(cwd);
  const relativePath = path.relative(cwd, schemaPath);

  if (!fs.existsSync(schemaPath)) {
    return {
      path: schemaPath,
      relativePath,
      exists: false,
      check: {
        ok: false,
        errors: [
          `Generated schema file ${relativePath} was not found. Run khotan-data generate.`,
        ],
        warnings: [],
        expectedVersion: KHOTAN_RUNTIME_SCHEMA_VERSION,
        foundVersion: null,
      },
    };
  }

  const source = fs.readFileSync(schemaPath, "utf-8");
  return {
    path: schemaPath,
    relativePath,
    exists: true,
    check: checkKhotanGeneratedSchemaSource(source),
  };
}

export function printGeneratedSchemaCheck(
  result: GeneratedSchemaCheckResult,
): void {
  console.log(`Checking generated schema: ${result.relativePath}`);
  console.log(formatKhotanRuntimeSchemaCheck(result.check, "Generated schema"));
}

export async function loadRuntimeDatabaseStateFromUrl(
  cwd: string,
  databaseUrl: string,
  options: { schemaName?: string } = {},
): Promise<KhotanRuntimeDatabaseState> {
  const postgres = await loadPostgres(cwd);
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    return await loadKhotanRuntimeDatabaseState(async (query) => {
      return rowsFromPostgresResult(await client.unsafe(query));
    }, options);
  } finally {
    await client.end();
  }
}

export async function applyRuntimeMigrationsFromUrl(
  cwd: string,
  databaseUrl: string,
): Promise<void> {
  const postgres = await loadPostgres(cwd);
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    for (const statement of getKhotanRuntimeMigrationStatements()) {
      await client.unsafe(statement);
    }
  } finally {
    await client.end();
  }
}

async function loadPostgres(cwd: string): Promise<PostgresFactory> {
  const projectPackagePath = path.join(cwd, "package.json");
  const requireFromProject = createRequire(projectPackagePath);
  let resolved: string;
  try {
    resolved = requireFromProject.resolve("postgres");
  } catch {
    throw new Error(
      'Could not load the "postgres" package from this project. Run `npm install postgres` or `khotan-data init --full` before live database checks.',
    );
  }

  const mod = (await import(pathToFileURL(resolved).href)) as {
    default?: unknown;
  };
  if (typeof mod.default !== "function") {
    throw new Error('The resolved "postgres" package did not export a client.');
  }
  return mod.default as PostgresFactory;
}

function rowsFromPostgresResult(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"].filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
