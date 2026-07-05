import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  KHOTAN_RUNTIME_REQUIRED_COLUMNS,
  KHOTAN_RUNTIME_REQUIRED_INDEXES,
  KHOTAN_RUNTIME_SCHEMA_VERSION,
  checkKhotanGeneratedSchemaSource,
  checkKhotanRuntimeDatabaseState,
  renderKhotanRuntimeMigrationSql,
  type KhotanRuntimeDatabaseState,
} from "./runtime-schema.js";

function completeDatabaseState(): KhotanRuntimeDatabaseState {
  return {
    version: KHOTAN_RUNTIME_SCHEMA_VERSION,
    columns: KHOTAN_RUNTIME_REQUIRED_COLUMNS.map((column) => ({
      tableName: column.table,
      columnName: column.column,
    })),
    indexes: KHOTAN_RUNTIME_REQUIRED_INDEXES.map((index) => ({
      tableName: index.table,
      indexName: index.name,
    })),
  };
}

describe("Khotan runtime schema contract", () => {
  it("accepts the generated schema template as the current runtime version", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../cli/templates/schema.ts"),
      "utf-8",
    );

    const check = checkKhotanGeneratedSchemaSource(source);

    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
    expect(check.foundVersion).toBe(KHOTAN_RUNTIME_SCHEMA_VERSION);
  });

  it("flags stale generated schema missing version metadata and skipped", () => {
    const source = `
      import { integer, pgTable, text } from "drizzle-orm/pg-core";
      export const khotanRuns = pgTable("khotan_runs", {
        id: text("id").primaryKey(),
        failed: integer("failed").default(0).notNull(),
      });
    `;

    const check = checkKhotanGeneratedSchemaSource(source);

    expect(check.ok).toBe(false);
    expect(check.errors).toContain(
      `Generated schema is missing KHOTAN_RUNTIME_SCHEMA_VERSION=${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}.`,
    );
    expect(check.errors).toContain(
      "Generated schema is missing column khotan_runs.skipped.",
    );
  });

  it("accepts a complete database state", () => {
    const check = checkKhotanRuntimeDatabaseState(completeDatabaseState());

    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
  });

  it("flags missing required database columns and indexes", () => {
    const state = completeDatabaseState();
    state.columns = state.columns.filter(
      (column) =>
        !(
          column.tableName === "khotan_runs" && column.columnName === "skipped"
        ),
    );
    state.indexes = state.indexes.filter(
      (index) =>
        !(
          index.tableName === "khotan_runs" &&
          index.indexName === "khotan_runs_status_idx"
        ),
    );

    const check = checkKhotanRuntimeDatabaseState(state);

    expect(check.ok).toBe(false);
    expect(check.errors).toContain(
      "Database is missing column khotan_runs.skipped.",
    );
    expect(check.errors).toContain(
      "Database is missing index khotan_runs.khotan_runs_status_idx.",
    );
  });

  it("warns instead of failing when only database version metadata is missing", () => {
    const state = completeDatabaseState();
    state.version = null;
    state.columns = state.columns.filter(
      (column) => column.tableName !== "khotan_runtime_schema",
    );

    const check = checkKhotanRuntimeDatabaseState(state);

    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([
      expect.stringContaining("no khotan_runtime_schema version row"),
    ]);
  });

  it("renders idempotent runtime migration SQL with version metadata", () => {
    const sql = renderKhotanRuntimeMigrationSql();

    expect(sql).toContain(
      `-- khotan-runtime-schema-version: ${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}`,
    );
    expect(sql).toContain('create table if not exists "khotan_runtime_schema"');
    expect(sql).toContain(
      'alter table "khotan_runs" add column if not exists "skipped"',
    );
    expect(sql).toContain('insert into "khotan_runtime_schema"');
  });
});
