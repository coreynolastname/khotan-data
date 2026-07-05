import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { InferSelectModel } from "drizzle-orm";
import type { CacheScope } from "./types.js";

// ---------------------------------------------------------------------------
// Internal schema — mirrors the scaffolded template so the factory can query
// the same tables without importing from the user's project.
// ---------------------------------------------------------------------------

export const khotanPlugs = pgTable("khotan_plugs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  baseUrl: text("base_url").notNull(),
  authType: text("auth_type").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  status: text("status", {
    enum: ["connected", "error", "idle"],
  })
    .default("idle")
    .notNull(),
  statusMessage: text("status_message"),
  encryptedVars: text("encrypted_vars"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const khotanResources = pgTable("khotan_resources", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  connectField: text("connect_field").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const khotanFlows = pgTable(
  "khotan_flows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    plugId: text("plug_id").notNull(),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["inflow", "outflow", "relay", "webhook"],
    }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    schedule: text("schedule"),
    resourceId: text("resource_id"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status", {
      enum: ["completed", "partial", "failed", "cancelled"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("khotan_flows_plug_id_name_unique").on(table.plugId, table.name),
    index("khotan_flows_plug_id_idx").on(table.plugId),
    index("khotan_flows_resource_id_idx").on(table.resourceId),
  ],
);

export const khotanWires = pgTable(
  "khotan_wires",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    plugId: text("plug_id").notNull(),
    remoteId: text("remote_id").notNull(),
    callbackUrl: text("callback_url").notNull(),
    eventTypes: jsonb("event_types").notNull().$type<string[]>(),
    status: text("status", {
      enum: ["active", "disabled", "pending"],
    })
      .default("pending")
      .notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("khotan_wires_plug_id_idx").on(table.plugId),
    index("khotan_wires_status_idx").on(table.status),
  ],
);

export const khotanWebhookHandlers = pgTable(
  "khotan_webhook_handlers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    wireId: text("wire_id").notNull(),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["catch", "pass"],
    }).notNull(),
    destinationPlugId: text("destination_plug_id"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("khotan_webhook_handlers_wire_id_name_unique").on(
      table.wireId,
      table.name,
    ),
    index("khotan_webhook_handlers_wire_id_idx").on(table.wireId),
  ],
);

export const khotanWebhookEvents = pgTable(
  "khotan_webhook_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    wireId: text("wire_id").notNull(),
    webhookHandlerId: text("webhook_handler_id").notNull(),
    khotanRunId: text("khotan_run_id"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    headers: jsonb("headers").notNull().$type<Record<string, string>>(),
    status: text("status", {
      enum: [
        "received",
        "queued",
        "processing",
        "processed",
        "ignored",
        "failed",
        "duplicate",
      ],
    })
      .default("received")
      .notNull(),
    idempotencyKey: text("idempotency_key"),
    dedupeKey: text("dedupe_key"),
    duplicateOfWebhookEventId: text("duplicate_of_webhook_event_id"),
    attempts: integer("attempts").default(0).notNull(),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("khotan_webhook_events_handler_id_dedupe_key_unique").on(
      table.webhookHandlerId,
      table.dedupeKey,
    ),
    index("khotan_webhook_events_wire_id_idx").on(table.wireId),
    index("khotan_webhook_events_webhook_handler_id_idx").on(
      table.webhookHandlerId,
    ),
    index("khotan_webhook_events_khotan_run_id_idx").on(table.khotanRunId),
    index("khotan_webhook_events_status_idx").on(table.status),
    index("khotan_webhook_events_duplicate_of_idx").on(
      table.duplicateOfWebhookEventId,
    ),
    index("khotan_webhook_events_processing_started_at_idx").on(
      table.processingStartedAt,
    ),
    index("khotan_webhook_events_received_at_idx").on(table.receivedAt.desc()),
  ],
);

export const khotanRuns = pgTable(
  "khotan_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    flowId: text("flow_id"),
    wireId: text("wire_id"),
    webhookHandlerId: text("webhook_handler_id"),
    workflowRunId: text("workflow_run_id"),
    // Default is a migration safety net so adding this NOT NULL column to a
    // table with existing rows never fails; the runtime always supplies it.
    variant: text("variant").default("default").notNull(),
    source: text("source", {
      enum: ["scheduled", "manual", "webhook"],
    })
      .default("manual")
      .notNull(),
    status: text("status", {
      enum: [
        "pending",
        "running",
        "completed",
        "partial",
        "failed",
        "cancelled",
      ],
    })
      .default("pending")
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    extracted: integer("extracted").default(0).notNull(),
    transformed: integer("transformed").default(0).notNull(),
    created: integer("created").default(0).notNull(),
    updated: integer("updated").default(0).notNull(),
    deleted: integer("deleted").default(0).notNull(),
    failed: integer("failed").default(0).notNull(),
    skipped: integer("skipped").default(0).notNull(),
    error: text("error"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("khotan_runs_flow_id_idx").on(table.flowId),
    index("khotan_runs_wire_id_idx").on(table.wireId),
    index("khotan_runs_webhook_handler_id_idx").on(table.webhookHandlerId),
    index("khotan_runs_status_idx").on(table.status),
    index("khotan_runs_flow_id_started_at_idx").on(
      table.flowId,
      table.startedAt.desc(),
    ),
  ],
);

export const khotanRunUpdates = pgTable(
  "khotan_run_updates",
  {
    runId: text("run_id").notNull(),
    index: integer("index").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .defaultNow()
      .notNull(),
    namespace: text("namespace"),
    type: text("type", {
      enum: ["progress", "log", "metric", "error"],
    }).notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    counters: jsonb("counters").$type<Record<string, number>>(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.index],
      name: "khotan_run_updates_run_id_index_pk",
    }),
    index("khotan_run_updates_run_id_idx").on(table.runId),
    index("khotan_run_updates_run_id_timestamp_idx").on(
      table.runId,
      table.timestamp,
    ),
  ],
);

export const khotanMappingsTable = pgTable(
  "khotan_mappings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    resourceId: text("resource_id").notNull(),
    connectValue: text("connect_value").notNull(),
    refs: jsonb("refs").notNull().$type<Record<string, string>>().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("khotan_mappings_resource_id_connect_value_unique").on(
      table.resourceId,
      table.connectValue,
    ),
    index("khotan_mappings_resource_id_idx").on(table.resourceId),
    index("khotan_mappings_refs_gin_idx").using("gin", table.refs),
  ],
);

export const khotanCaches = pgTable(
  "khotan_caches",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().unique(),
    scope: jsonb("scope").$type<CacheScope>(),
    ttlSeconds: integer("ttl_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("khotan_caches_name_idx").on(table.name)],
);

export const khotanCacheEntries = pgTable(
  "khotan_cache_entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    cacheId: text("cache_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull().$type<unknown>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("khotan_cache_entries_cache_id_key_unique").on(
      table.cacheId,
      table.key,
    ),
    index("khotan_cache_entries_cache_id_idx").on(table.cacheId),
    index("khotan_cache_entries_cache_id_key_idx").on(table.cacheId, table.key),
    index("khotan_cache_entries_expires_at_idx").on(table.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Typed row models — inferred from the Drizzle tables so they can't drift.
// ---------------------------------------------------------------------------

export type PlugRow = InferSelectModel<typeof khotanPlugs>;
export type ResourceRow = InferSelectModel<typeof khotanResources>;
export type FlowRow = InferSelectModel<typeof khotanFlows>;
export type WireRow = InferSelectModel<typeof khotanWires>;
export type WebhookHandlerRow = InferSelectModel<typeof khotanWebhookHandlers>;
export type WebhookEventRow = InferSelectModel<typeof khotanWebhookEvents>;
export type RunRow = InferSelectModel<typeof khotanRuns>;
export type RunUpdateRow = InferSelectModel<typeof khotanRunUpdates>;
export type MappingRow = InferSelectModel<typeof khotanMappingsTable>;
export type CacheRow = InferSelectModel<typeof khotanCaches>;
export type CacheEntryRow = InferSelectModel<typeof khotanCacheEntries>;
