export const KHOTAN_RUNTIME_SCHEMA_VERSION = 2 as const;
export const KHOTAN_RUNTIME_SCHEMA_TABLE = "khotan_runtime_schema";
export const KHOTAN_RUNTIME_SCHEMA_ROW_ID = "runtime";

export interface KhotanRuntimeColumnRequirement {
  table: string;
  column: string;
}

export interface KhotanRuntimeIndexRequirement {
  table: string;
  name: string;
  createSql: string;
}

export interface KhotanRuntimeDatabaseColumn {
  tableName: string;
  columnName: string;
}

export interface KhotanRuntimeDatabaseIndex {
  tableName: string;
  indexName: string;
}

export interface KhotanRuntimeDatabaseState {
  version: number | null;
  columns: KhotanRuntimeDatabaseColumn[];
  indexes: KhotanRuntimeDatabaseIndex[];
}

export interface KhotanRuntimeSchemaCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  expectedVersion: number;
  foundVersion: number | null;
}

export type KhotanRuntimeSchemaQuery = (
  query: string,
) => Promise<Record<string, unknown>[]>;

export const KHOTAN_RUNTIME_TABLES = [
  KHOTAN_RUNTIME_SCHEMA_TABLE,
  "khotan_plugs",
  "khotan_resources",
  "khotan_flows",
  "khotan_wires",
  "khotan_webhook_handlers",
  "khotan_webhook_events",
  "khotan_runs",
  "khotan_mappings",
  "khotan_caches",
  "khotan_cache_entries",
] as const;

export const KHOTAN_RUNTIME_REQUIRED_COLUMNS: readonly KhotanRuntimeColumnRequirement[] =
  [
    { table: KHOTAN_RUNTIME_SCHEMA_TABLE, column: "id" },
    { table: KHOTAN_RUNTIME_SCHEMA_TABLE, column: "version" },
    { table: KHOTAN_RUNTIME_SCHEMA_TABLE, column: "updated_at" },

    { table: "khotan_plugs", column: "id" },
    { table: "khotan_plugs", column: "name" },
    { table: "khotan_plugs", column: "base_url" },
    { table: "khotan_plugs", column: "auth_type" },
    { table: "khotan_plugs", column: "enabled" },
    { table: "khotan_plugs", column: "status" },
    { table: "khotan_plugs", column: "status_message" },
    { table: "khotan_plugs", column: "encrypted_vars" },
    { table: "khotan_plugs", column: "created_at" },
    { table: "khotan_plugs", column: "updated_at" },

    { table: "khotan_resources", column: "id" },
    { table: "khotan_resources", column: "name" },
    { table: "khotan_resources", column: "connect_field" },
    { table: "khotan_resources", column: "description" },
    { table: "khotan_resources", column: "created_at" },
    { table: "khotan_resources", column: "updated_at" },

    { table: "khotan_flows", column: "id" },
    { table: "khotan_flows", column: "plug_id" },
    { table: "khotan_flows", column: "name" },
    { table: "khotan_flows", column: "type" },
    { table: "khotan_flows", column: "enabled" },
    { table: "khotan_flows", column: "schedule" },
    { table: "khotan_flows", column: "resource_id" },
    { table: "khotan_flows", column: "last_run_at" },
    { table: "khotan_flows", column: "last_run_status" },
    { table: "khotan_flows", column: "created_at" },
    { table: "khotan_flows", column: "updated_at" },

    { table: "khotan_wires", column: "id" },
    { table: "khotan_wires", column: "plug_id" },
    { table: "khotan_wires", column: "remote_id" },
    { table: "khotan_wires", column: "callback_url" },
    { table: "khotan_wires", column: "event_types" },
    { table: "khotan_wires", column: "status" },
    { table: "khotan_wires", column: "metadata" },
    { table: "khotan_wires", column: "created_at" },
    { table: "khotan_wires", column: "updated_at" },

    { table: "khotan_webhook_handlers", column: "id" },
    { table: "khotan_webhook_handlers", column: "wire_id" },
    { table: "khotan_webhook_handlers", column: "name" },
    { table: "khotan_webhook_handlers", column: "type" },
    { table: "khotan_webhook_handlers", column: "destination_plug_id" },
    { table: "khotan_webhook_handlers", column: "enabled" },
    { table: "khotan_webhook_handlers", column: "created_at" },
    { table: "khotan_webhook_handlers", column: "updated_at" },

    { table: "khotan_webhook_events", column: "id" },
    { table: "khotan_webhook_events", column: "wire_id" },
    { table: "khotan_webhook_events", column: "webhook_handler_id" },
    { table: "khotan_webhook_events", column: "khotan_run_id" },
    { table: "khotan_webhook_events", column: "event_type" },
    { table: "khotan_webhook_events", column: "payload" },
    { table: "khotan_webhook_events", column: "headers" },
    { table: "khotan_webhook_events", column: "received_at" },

    { table: "khotan_runs", column: "id" },
    { table: "khotan_runs", column: "flow_id" },
    { table: "khotan_runs", column: "wire_id" },
    { table: "khotan_runs", column: "webhook_handler_id" },
    { table: "khotan_runs", column: "workflow_run_id" },
    { table: "khotan_runs", column: "variant" },
    { table: "khotan_runs", column: "source" },
    { table: "khotan_runs", column: "status" },
    { table: "khotan_runs", column: "started_at" },
    { table: "khotan_runs", column: "completed_at" },
    { table: "khotan_runs", column: "duration_ms" },
    { table: "khotan_runs", column: "extracted" },
    { table: "khotan_runs", column: "transformed" },
    { table: "khotan_runs", column: "created" },
    { table: "khotan_runs", column: "updated" },
    { table: "khotan_runs", column: "deleted" },
    { table: "khotan_runs", column: "failed" },
    { table: "khotan_runs", column: "skipped" },
    { table: "khotan_runs", column: "error" },
    { table: "khotan_runs", column: "metadata" },

    { table: "khotan_mappings", column: "id" },
    { table: "khotan_mappings", column: "resource_id" },
    { table: "khotan_mappings", column: "connect_value" },
    { table: "khotan_mappings", column: "refs" },
    { table: "khotan_mappings", column: "metadata" },
    { table: "khotan_mappings", column: "created_at" },
    { table: "khotan_mappings", column: "updated_at" },

    { table: "khotan_caches", column: "id" },
    { table: "khotan_caches", column: "name" },
    { table: "khotan_caches", column: "scope" },
    { table: "khotan_caches", column: "ttl_seconds" },
    { table: "khotan_caches", column: "created_at" },
    { table: "khotan_caches", column: "updated_at" },

    { table: "khotan_cache_entries", column: "id" },
    { table: "khotan_cache_entries", column: "cache_id" },
    { table: "khotan_cache_entries", column: "key" },
    { table: "khotan_cache_entries", column: "value" },
    { table: "khotan_cache_entries", column: "expires_at" },
    { table: "khotan_cache_entries", column: "created_at" },
    { table: "khotan_cache_entries", column: "updated_at" },
  ];

export const KHOTAN_RUNTIME_REQUIRED_INDEXES: readonly KhotanRuntimeIndexRequirement[] =
  [
    {
      table: "khotan_plugs",
      name: "khotan_plugs_name_unique",
      createSql:
        'create unique index if not exists "khotan_plugs_name_unique" on "khotan_plugs" ("name")',
    },
    {
      table: "khotan_resources",
      name: "khotan_resources_name_unique",
      createSql:
        'create unique index if not exists "khotan_resources_name_unique" on "khotan_resources" ("name")',
    },
    {
      table: "khotan_flows",
      name: "khotan_flows_plug_id_name_unique",
      createSql:
        'create unique index if not exists "khotan_flows_plug_id_name_unique" on "khotan_flows" ("plug_id", "name")',
    },
    {
      table: "khotan_flows",
      name: "khotan_flows_plug_id_idx",
      createSql:
        'create index if not exists "khotan_flows_plug_id_idx" on "khotan_flows" ("plug_id")',
    },
    {
      table: "khotan_flows",
      name: "khotan_flows_resource_id_idx",
      createSql:
        'create index if not exists "khotan_flows_resource_id_idx" on "khotan_flows" ("resource_id")',
    },
    {
      table: "khotan_wires",
      name: "khotan_wires_plug_id_idx",
      createSql:
        'create index if not exists "khotan_wires_plug_id_idx" on "khotan_wires" ("plug_id")',
    },
    {
      table: "khotan_wires",
      name: "khotan_wires_status_idx",
      createSql:
        'create index if not exists "khotan_wires_status_idx" on "khotan_wires" ("status")',
    },
    {
      table: "khotan_webhook_handlers",
      name: "khotan_webhook_handlers_wire_id_name_unique",
      createSql:
        'create unique index if not exists "khotan_webhook_handlers_wire_id_name_unique" on "khotan_webhook_handlers" ("wire_id", "name")',
    },
    {
      table: "khotan_webhook_handlers",
      name: "khotan_webhook_handlers_wire_id_idx",
      createSql:
        'create index if not exists "khotan_webhook_handlers_wire_id_idx" on "khotan_webhook_handlers" ("wire_id")',
    },
    {
      table: "khotan_webhook_events",
      name: "khotan_webhook_events_wire_id_idx",
      createSql:
        'create index if not exists "khotan_webhook_events_wire_id_idx" on "khotan_webhook_events" ("wire_id")',
    },
    {
      table: "khotan_webhook_events",
      name: "khotan_webhook_events_webhook_handler_id_idx",
      createSql:
        'create index if not exists "khotan_webhook_events_webhook_handler_id_idx" on "khotan_webhook_events" ("webhook_handler_id")',
    },
    {
      table: "khotan_webhook_events",
      name: "khotan_webhook_events_khotan_run_id_idx",
      createSql:
        'create index if not exists "khotan_webhook_events_khotan_run_id_idx" on "khotan_webhook_events" ("khotan_run_id")',
    },
    {
      table: "khotan_webhook_events",
      name: "khotan_webhook_events_received_at_idx",
      createSql:
        'create index if not exists "khotan_webhook_events_received_at_idx" on "khotan_webhook_events" ("received_at" desc)',
    },
    {
      table: "khotan_runs",
      name: "khotan_runs_flow_id_idx",
      createSql:
        'create index if not exists "khotan_runs_flow_id_idx" on "khotan_runs" ("flow_id")',
    },
    {
      table: "khotan_runs",
      name: "khotan_runs_wire_id_idx",
      createSql:
        'create index if not exists "khotan_runs_wire_id_idx" on "khotan_runs" ("wire_id")',
    },
    {
      table: "khotan_runs",
      name: "khotan_runs_webhook_handler_id_idx",
      createSql:
        'create index if not exists "khotan_runs_webhook_handler_id_idx" on "khotan_runs" ("webhook_handler_id")',
    },
    {
      table: "khotan_runs",
      name: "khotan_runs_status_idx",
      createSql:
        'create index if not exists "khotan_runs_status_idx" on "khotan_runs" ("status")',
    },
    {
      table: "khotan_runs",
      name: "khotan_runs_flow_id_started_at_idx",
      createSql:
        'create index if not exists "khotan_runs_flow_id_started_at_idx" on "khotan_runs" ("flow_id", "started_at" desc)',
    },
    {
      table: "khotan_mappings",
      name: "khotan_mappings_resource_id_connect_value_unique",
      createSql:
        'create unique index if not exists "khotan_mappings_resource_id_connect_value_unique" on "khotan_mappings" ("resource_id", "connect_value")',
    },
    {
      table: "khotan_mappings",
      name: "khotan_mappings_resource_id_idx",
      createSql:
        'create index if not exists "khotan_mappings_resource_id_idx" on "khotan_mappings" ("resource_id")',
    },
    {
      table: "khotan_mappings",
      name: "khotan_mappings_refs_gin_idx",
      createSql:
        'create index if not exists "khotan_mappings_refs_gin_idx" on "khotan_mappings" using gin ("refs")',
    },
    {
      table: "khotan_caches",
      name: "khotan_caches_name_unique",
      createSql:
        'create unique index if not exists "khotan_caches_name_unique" on "khotan_caches" ("name")',
    },
    {
      table: "khotan_caches",
      name: "khotan_caches_name_idx",
      createSql:
        'create index if not exists "khotan_caches_name_idx" on "khotan_caches" ("name")',
    },
    {
      table: "khotan_cache_entries",
      name: "khotan_cache_entries_cache_id_key_unique",
      createSql:
        'create unique index if not exists "khotan_cache_entries_cache_id_key_unique" on "khotan_cache_entries" ("cache_id", "key")',
    },
    {
      table: "khotan_cache_entries",
      name: "khotan_cache_entries_cache_id_idx",
      createSql:
        'create index if not exists "khotan_cache_entries_cache_id_idx" on "khotan_cache_entries" ("cache_id")',
    },
    {
      table: "khotan_cache_entries",
      name: "khotan_cache_entries_cache_id_key_idx",
      createSql:
        'create index if not exists "khotan_cache_entries_cache_id_key_idx" on "khotan_cache_entries" ("cache_id", "key")',
    },
    {
      table: "khotan_cache_entries",
      name: "khotan_cache_entries_expires_at_idx",
      createSql:
        'create index if not exists "khotan_cache_entries_expires_at_idx" on "khotan_cache_entries" ("expires_at")',
    },
  ];

export function extractKhotanRuntimeSchemaVersion(
  source: string,
): number | null {
  const match =
    /KHOTAN_RUNTIME_SCHEMA_VERSION\s*=\s*(\d+)(?:\s+as\s+const)?/.exec(source);
  if (!match) return null;
  return Number(match[1]);
}

export function checkKhotanGeneratedSchemaSource(
  source: string,
): KhotanRuntimeSchemaCheck {
  const foundVersion = extractKhotanRuntimeSchemaVersion(source);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (foundVersion === null) {
    errors.push(
      `Generated schema is missing KHOTAN_RUNTIME_SCHEMA_VERSION=${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}.`,
    );
  } else if (foundVersion !== KHOTAN_RUNTIME_SCHEMA_VERSION) {
    errors.push(
      `Generated schema declares Khotan runtime schema version ${String(foundVersion)}; expected ${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}.`,
    );
  }

  for (const table of KHOTAN_RUNTIME_TABLES) {
    if (!hasPgTable(source, table)) {
      errors.push(`Generated schema is missing table ${table}.`);
    }
  }

  for (const requirement of KHOTAN_RUNTIME_REQUIRED_COLUMNS) {
    if (!hasColumnDefinition(source, requirement.column)) {
      errors.push(
        `Generated schema is missing column ${requirement.table}.${requirement.column}.`,
      );
    }
  }

  for (const requirement of KHOTAN_RUNTIME_REQUIRED_INDEXES) {
    if (!hasIndexDefinition(source, requirement.name)) {
      errors.push(
        `Generated schema is missing index ${requirement.table}.${requirement.name}.`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    expectedVersion: KHOTAN_RUNTIME_SCHEMA_VERSION,
    foundVersion,
  };
}

export function checkKhotanRuntimeDatabaseState(
  state: KhotanRuntimeDatabaseState,
): KhotanRuntimeSchemaCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tableNames = new Set(state.columns.map((column) => column.tableName));
  const columnKeys = new Set(
    state.columns.map((column) => `${column.tableName}.${column.columnName}`),
  );
  const indexKeys = new Set(
    state.indexes.map((index) => `${index.tableName}.${index.indexName}`),
  );

  for (const table of KHOTAN_RUNTIME_TABLES) {
    if (table === KHOTAN_RUNTIME_SCHEMA_TABLE) continue;
    if (!tableNames.has(table)) {
      errors.push(`Database is missing table ${table}.`);
    }
  }

  for (const requirement of KHOTAN_RUNTIME_REQUIRED_COLUMNS) {
    if (requirement.table === KHOTAN_RUNTIME_SCHEMA_TABLE) continue;
    const key = `${requirement.table}.${requirement.column}`;
    if (!columnKeys.has(key)) {
      errors.push(`Database is missing column ${key}.`);
    }
  }

  for (const requirement of KHOTAN_RUNTIME_REQUIRED_INDEXES) {
    const key = `${requirement.table}.${requirement.name}`;
    if (!indexKeys.has(key)) {
      errors.push(`Database is missing index ${key}.`);
    }
  }

  if (state.version === null) {
    warnings.push(
      `Database has no ${KHOTAN_RUNTIME_SCHEMA_TABLE} version row; run khotan-data migrate --runtime to stamp Khotan-owned tables.`,
    );
  } else if (state.version < KHOTAN_RUNTIME_SCHEMA_VERSION) {
    warnings.push(
      `Database reports Khotan runtime schema version ${String(state.version)}; expected ${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}.`,
    );
  } else if (state.version > KHOTAN_RUNTIME_SCHEMA_VERSION) {
    warnings.push(
      `Database reports newer Khotan runtime schema version ${String(state.version)}; installed runtime expects ${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}.`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    expectedVersion: KHOTAN_RUNTIME_SCHEMA_VERSION,
    foundVersion: state.version,
  };
}

export function formatKhotanRuntimeSchemaCheck(
  check: KhotanRuntimeSchemaCheck,
  label: string,
  options: { maxIssues?: number } = {},
): string {
  const maxIssues = options.maxIssues ?? 12;
  const lines: string[] = [];
  if (check.errors.length === 0 && check.warnings.length === 0) {
    lines.push(
      `✓ ${label} matches Khotan runtime schema version ${String(check.expectedVersion)}`,
    );
    return lines.join("\n");
  }

  if (check.errors.length > 0) {
    lines.push(`✗ ${label} has ${String(check.errors.length)} error(s):`);
    lines.push(...formatIssueLines(check.errors, maxIssues));
  }

  if (check.warnings.length > 0) {
    lines.push(`⚠ ${label} has ${String(check.warnings.length)} warning(s):`);
    lines.push(...formatIssueLines(check.warnings, maxIssues));
  }

  return lines.join("\n");
}

export function getKhotanRuntimeMigrationStatements(): string[] {
  return [
    `create table if not exists "${KHOTAN_RUNTIME_SCHEMA_TABLE}" (
  "id" text primary key default '${KHOTAN_RUNTIME_SCHEMA_ROW_ID}',
  "version" integer not null,
  "updated_at" timestamp with time zone not null default now()
)`,
    `alter table "${KHOTAN_RUNTIME_SCHEMA_TABLE}" add column if not exists "version" integer not null default 0`,
    `alter table "${KHOTAN_RUNTIME_SCHEMA_TABLE}" add column if not exists "updated_at" timestamp with time zone not null default now()`,
    'alter table "khotan_runs" add column if not exists "skipped" integer not null default 0',
    ...KHOTAN_RUNTIME_REQUIRED_INDEXES.map((index) => index.createSql),
    `insert into "${KHOTAN_RUNTIME_SCHEMA_TABLE}" ("id", "version", "updated_at")
values ('${KHOTAN_RUNTIME_SCHEMA_ROW_ID}', ${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}, now())
on conflict ("id") do update
set "version" = greatest("${KHOTAN_RUNTIME_SCHEMA_TABLE}"."version", excluded."version"),
    "updated_at" = now()`,
  ];
}

export function renderKhotanRuntimeMigrationSql(): string {
  const statements = getKhotanRuntimeMigrationStatements()
    .map((statement) => `${statement};`)
    .join("\n\n");
  return [
    `-- khotan-runtime-schema-version: ${String(KHOTAN_RUNTIME_SCHEMA_VERSION)}`,
    "-- Khotan-owned runtime table upgrade SQL.",
    "-- Run through `khotan-data migrate --runtime` or apply inside your app migration system.",
    statements,
    "",
  ].join("\n");
}

export function getKhotanRuntimeIntrospectionSql(
  options: {
    schemaName?: string;
  } = {},
): {
  columns: string;
  indexes: string;
  version: string;
} {
  const schemaPredicate = options.schemaName
    ? `= ${sqlLiteral(options.schemaName)}`
    : "= current_schema()";
  const tableList = KHOTAN_RUNTIME_TABLES.map(sqlLiteral).join(", ");

  return {
    columns: `select table_name, column_name
from information_schema.columns
where table_schema ${schemaPredicate}
  and table_name in (${tableList})
order by table_name, ordinal_position`,
    indexes: `select tablename as table_name, indexname as index_name
from pg_indexes
where schemaname ${schemaPredicate}
  and tablename in (${tableList})
order by tablename, indexname`,
    version: `select "version"
from "${KHOTAN_RUNTIME_SCHEMA_TABLE}"
where "id" = '${KHOTAN_RUNTIME_SCHEMA_ROW_ID}'
limit 1`,
  };
}

export async function loadKhotanRuntimeDatabaseState(
  query: KhotanRuntimeSchemaQuery,
  options: { schemaName?: string } = {},
): Promise<KhotanRuntimeDatabaseState> {
  const introspection = getKhotanRuntimeIntrospectionSql(options);
  const [columnRows, indexRows] = await Promise.all([
    query(introspection.columns),
    query(introspection.indexes),
  ]);

  let version: number | null = null;
  try {
    const rows = await query(introspection.version);
    const value = rows[0]?.["version"];
    version = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(version)) version = null;
  } catch {
    version = null;
  }

  return {
    version,
    columns: columnRows
      .map((row) => ({
        tableName: normalizeString(row["table_name"] ?? row["tableName"]),
        columnName: normalizeString(row["column_name"] ?? row["columnName"]),
      }))
      .filter(isCompleteColumn),
    indexes: indexRows
      .map((row) => ({
        tableName: normalizeString(row["table_name"] ?? row["tableName"]),
        indexName: normalizeString(row["index_name"] ?? row["indexName"]),
      }))
      .filter(isCompleteIndex),
  };
}

function hasPgTable(source: string, table: string): boolean {
  return new RegExp(`pgTable\\(\\s*["']${escapeRegExp(table)}["']`, "m").test(
    source,
  );
}

function hasColumnDefinition(source: string, column: string): boolean {
  return new RegExp(
    `\\b[a-zA-Z0-9_]+\\s*\\(\\s*["']${escapeRegExp(column)}["']`,
    "m",
  ).test(source);
}

function hasIndexDefinition(source: string, indexName: string): boolean {
  return new RegExp(
    `\\b(?:index|unique)\\(\\s*["']${escapeRegExp(indexName)}["']`,
    "m",
  ).test(source);
}

function formatIssueLines(issues: string[], maxIssues: number): string[] {
  const visible = issues.slice(0, maxIssues).map((issue) => `  - ${issue}`);
  const remaining = issues.length - visible.length;
  if (remaining > 0) {
    visible.push(`  - ...and ${String(remaining)} more`);
  }
  return visible;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isCompleteColumn(
  value: KhotanRuntimeDatabaseColumn,
): value is KhotanRuntimeDatabaseColumn {
  return value.tableName.length > 0 && value.columnName.length > 0;
}

function isCompleteIndex(
  value: KhotanRuntimeDatabaseIndex,
): value is KhotanRuntimeDatabaseIndex {
  return value.tableName.length > 0 && value.indexName.length > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
