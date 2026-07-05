import { and, eq, desc, asc, sql, count, inArray, lte, gte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  khotanPlugs,
  khotanResources,
  khotanFlows,
  khotanWires,
  khotanWebhookHandlers,
  khotanWebhookEvents,
  khotanRuns,
  khotanRunUpdates,
  khotanMappingsTable,
  khotanCaches,
  khotanCacheEntries,
} from "./schema.js";
import type {
  FlowType,
  KhotanAdapter,
  KhotanPersistedRunUpdate,
  KhotanRunStatus,
} from "./types.js";
import { serializeConnectField, deserializeConnectField } from "./helpers.js";

export type KhotanDrizzleDatabase<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
  TFullSchema extends Record<string, unknown> = Record<string, never>,
> = Pick<
  PgDatabase<TQueryResult, TFullSchema>,
  "select" | "insert" | "update" | "delete" | "execute"
>;

function toPersistedRunUpdate(row: {
  runId: string;
  index: number;
  timestamp: Date;
  namespace: string | null;
  type: "progress" | "log" | "metric" | "error";
  message: string;
  metadata: Record<string, unknown> | null;
  counters: Record<string, number> | null;
}): KhotanPersistedRunUpdate {
  return {
    runId: row.runId,
    index: row.index,
    timestamp: row.timestamp,
    namespace: row.namespace,
    type: row.type,
    message: row.message,
    metadata: row.metadata ?? null,
    counters: row.counters ?? null,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("duplicate key") ||
    message.includes("unique constraint") ||
    message.includes("SQLITE_CONSTRAINT")
  );
}

export function drizzleAdapter<
  TQueryResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
>(db: KhotanDrizzleDatabase<TQueryResult, TFullSchema>): KhotanAdapter {
  return {
    async upsertPlug(plug) {
      const rows = await db
        .insert(khotanPlugs)
        .values({
          name: plug.name,
          baseUrl: plug.baseUrl,
          authType: plug.authType,
        })
        .onConflictDoUpdate({
          target: khotanPlugs.name,
          set: {
            baseUrl: plug.baseUrl,
            authType: plug.authType,
            updatedAt: new Date(),
          },
        })
        .returning({ id: khotanPlugs.id });
      return { id: rows[0]!.id };
    },

    async upsertFlow(flow) {
      const rows = await db
        .insert(khotanFlows)
        .values({
          plugId: flow.plugId,
          name: flow.name,
          type: flow.type as FlowType,
          schedule: flow.schedule ?? null,
        })
        .onConflictDoUpdate({
          target: [khotanFlows.plugId, khotanFlows.name],
          set: {
            type: flow.type as FlowType,
            schedule: flow.schedule ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: khotanFlows.id });
      return { id: rows[0]!.id };
    },

    async listPlugs() {
      const flowCounts = db
        .select({
          plugId: khotanFlows.plugId,
          flowCount: count(khotanFlows.id).as("flow_count"),
        })
        .from(khotanFlows)
        .groupBy(khotanFlows.plugId)
        .as("flow_counts");

      const rows = await db
        .select({
          id: khotanPlugs.id,
          name: khotanPlugs.name,
          baseUrl: khotanPlugs.baseUrl,
          authType: khotanPlugs.authType,
          enabled: khotanPlugs.enabled,
          status: khotanPlugs.status,
          statusMessage: khotanPlugs.statusMessage,
          createdAt: khotanPlugs.createdAt,
          updatedAt: khotanPlugs.updatedAt,
          flowCount: sql<number>`coalesce(${flowCounts.flowCount}, 0)`,
        })
        .from(khotanPlugs)
        .leftJoin(flowCounts, eq(khotanPlugs.id, flowCounts.plugId));

      return rows;
    },

    async getPlug(id) {
      const rows = await db
        .select()
        .from(khotanPlugs)
        .where(eq(khotanPlugs.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async getPlugFlows(plugId) {
      return db
        .select()
        .from(khotanFlows)
        .where(eq(khotanFlows.plugId, plugId));
    },

    async getFlow(flowId) {
      const rows = await db
        .select({
          id: khotanFlows.id,
          plugId: khotanFlows.plugId,
          name: khotanFlows.name,
          type: khotanFlows.type,
          enabled: khotanFlows.enabled,
          schedule: khotanFlows.schedule,
          resourceId: khotanFlows.resourceId,
          lastRunAt: khotanFlows.lastRunAt,
          lastRunStatus: khotanFlows.lastRunStatus,
          createdAt: khotanFlows.createdAt,
          updatedAt: khotanFlows.updatedAt,
          plugName: khotanPlugs.name,
        })
        .from(khotanFlows)
        .leftJoin(khotanPlugs, eq(khotanFlows.plugId, khotanPlugs.id))
        .where(eq(khotanFlows.id, flowId))
        .limit(1);
      return rows[0] ?? null;
    },

    async listFlows() {
      const rows = await db
        .select({
          id: khotanFlows.id,
          plugId: khotanFlows.plugId,
          name: khotanFlows.name,
          type: khotanFlows.type,
          enabled: khotanFlows.enabled,
          schedule: khotanFlows.schedule,
          resourceId: khotanFlows.resourceId,
          lastRunAt: khotanFlows.lastRunAt,
          lastRunStatus: khotanFlows.lastRunStatus,
          createdAt: khotanFlows.createdAt,
          updatedAt: khotanFlows.updatedAt,
          plugName: khotanPlugs.name,
        })
        .from(khotanFlows)
        .leftJoin(khotanPlugs, eq(khotanFlows.plugId, khotanPlugs.id));

      return rows;
    },

    async listRuns(flowId) {
      return db
        .select()
        .from(khotanRuns)
        .where(eq(khotanRuns.flowId, flowId))
        .orderBy(desc(khotanRuns.startedAt));
    },

    async getRun(runId) {
      const rows = await db
        .select()
        .from(khotanRuns)
        .where(eq(khotanRuns.id, runId))
        .limit(1);
      return rows[0] ?? null;
    },

    async listRunsPage({ limit, offset }) {
      const rows = await db
        .select()
        .from(khotanRuns)
        .orderBy(desc(khotanRuns.startedAt))
        .limit(limit + 1)
        .offset(offset);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);

      const flowIds = [
        ...new Set(
          pageRows
            .map((row) => row.flowId)
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
      const handlerIds = [
        ...new Set(
          pageRows
            .map((row) => row.webhookHandlerId)
            .filter((value): value is string => typeof value === "string"),
        ),
      ];

      const flowRows =
        flowIds.length > 0
          ? await db
              .select({
                id: khotanFlows.id,
                name: khotanFlows.name,
                plugName: khotanPlugs.name,
              })
              .from(khotanFlows)
              .leftJoin(khotanPlugs, eq(khotanFlows.plugId, khotanPlugs.id))
              .where(inArray(khotanFlows.id, flowIds))
          : [];

      const handlerRows =
        handlerIds.length > 0
          ? await db
              .select({
                id: khotanWebhookHandlers.id,
                name: khotanWebhookHandlers.name,
                type: khotanWebhookHandlers.type,
                plugName: khotanPlugs.name,
              })
              .from(khotanWebhookHandlers)
              .leftJoin(
                khotanWires,
                eq(khotanWebhookHandlers.wireId, khotanWires.id),
              )
              .leftJoin(khotanPlugs, eq(khotanWires.plugId, khotanPlugs.id))
              .where(inArray(khotanWebhookHandlers.id, handlerIds))
          : [];

      const flowMap = new Map(flowRows.map((row) => [row.id, row]));
      const handlerMap = new Map(handlerRows.map((row) => [row.id, row]));

      return {
        items: pageRows.map((row) => {
          const flow = row.flowId ? flowMap.get(row.flowId) : null;
          const handler = row.webhookHandlerId
            ? handlerMap.get(row.webhookHandlerId)
            : null;
          return {
            ...row,
            sourceType: flow ? "flow" : handler ? "webhook" : "unknown",
            sourceName: flow?.name ?? handler?.name ?? null,
            sourceKind: handler?.type ?? null,
            plugName: flow?.plugName ?? handler?.plugName ?? null,
          };
        }),
        hasMore,
      };
    },

    async appendRunUpdate(update) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await db
          .select({ index: khotanRunUpdates.index })
          .from(khotanRunUpdates)
          .where(eq(khotanRunUpdates.runId, update.runId))
          .orderBy(desc(khotanRunUpdates.index))
          .limit(1);
        const nextIndex = (latest[0]?.index ?? -1) + 1;

        try {
          const rows = await db
            .insert(khotanRunUpdates)
            .values({
              runId: update.runId,
              index: nextIndex,
              timestamp: update.timestamp,
              namespace: update.namespace ?? null,
              type: update.type,
              message: update.message,
              metadata: update.metadata ?? null,
              counters: update.counters ?? null,
            })
            .returning({ index: khotanRunUpdates.index });
          return { index: rows[0]!.index };
        } catch (error) {
          if (attempt === 2 || !isUniqueConstraintError(error)) {
            throw error;
          }
        }
      }

      throw new Error("Failed to append run update");
    },

    async listRunUpdates({ runId, startIndex, namespace, limit }) {
      const filters = [eq(khotanRunUpdates.runId, runId)];
      if (namespace) {
        filters.push(eq(khotanRunUpdates.namespace, namespace));
      }

      if (typeof startIndex === "number" && startIndex < 0) {
        const rows = await db
          .select()
          .from(khotanRunUpdates)
          .where(and(...filters))
          .orderBy(desc(khotanRunUpdates.index))
          .limit(Math.min(Math.abs(startIndex), limit ?? 500));
        return rows.reverse().map(toPersistedRunUpdate);
      }

      if (typeof startIndex === "number") {
        filters.push(gte(khotanRunUpdates.index, startIndex));
      }

      const query = db
        .select()
        .from(khotanRunUpdates)
        .where(and(...filters))
        .orderBy(asc(khotanRunUpdates.index));

      const rows =
        typeof limit === "number" ? await query.limit(limit) : await query;
      return rows.map(toPersistedRunUpdate);
    },

    async listStuckRuns({ flowId, olderThan, statuses, limit }) {
      const filters = [
        inArray(khotanRuns.status, statuses),
        lte(khotanRuns.startedAt, olderThan),
      ];
      if (flowId) {
        filters.push(eq(khotanRuns.flowId, flowId));
      }

      return db
        .select()
        .from(khotanRuns)
        .where(and(...filters))
        .orderBy(khotanRuns.startedAt)
        .limit(limit);
    },

    async claimStuckRun({
      runId,
      olderThan,
      fromStatuses,
      toStatus,
      completedAt,
      durationMs,
      error,
    }) {
      const rows = await db
        .update(khotanRuns)
        .set({
          status: toStatus,
          completedAt,
          durationMs: durationMs ?? null,
          failed: toStatus === "failed" ? 1 : 0,
          error,
        })
        .where(
          and(
            eq(khotanRuns.id, runId),
            inArray(khotanRuns.status, fromStatuses),
            lte(khotanRuns.startedAt, olderThan),
          ),
        )
        .returning({ id: khotanRuns.id });
      return rows.length > 0;
    },

    async claimRunTerminal({ runId, fromStatuses, updates }) {
      const rows = await db
        .update(khotanRuns)
        .set({
          status: updates.status,
          completedAt: updates.completedAt,
          durationMs: updates.durationMs,
          extracted: updates.extracted,
          transformed: updates.transformed,
          created: updates.created,
          updated: updates.updated,
          deleted: updates.deleted,
          failed: updates.failed,
          skipped: updates.skipped,
          error: updates.error,
          metadata: updates.metadata,
        })
        .where(
          and(
            eq(khotanRuns.id, runId),
            inArray(khotanRuns.status, fromStatuses),
          ),
        )
        .returning({ id: khotanRuns.id });
      return rows.length > 0;
    },

    async upsertResource(resource) {
      const rows = await db
        .insert(khotanResources)
        .values({
          name: resource.name,
          connectField: serializeConnectField(resource.connectField),
          description: resource.description ?? null,
        })
        .onConflictDoUpdate({
          target: khotanResources.name,
          set: {
            connectField: serializeConnectField(resource.connectField),
            description: resource.description ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: khotanResources.id });
      return { id: rows[0]!.id };
    },

    async upsertCache(cache) {
      const rows = await db
        .insert(khotanCaches)
        .values({
          name: cache.name,
          scope: cache.scope ?? null,
          ttlSeconds: cache.ttlSeconds ?? null,
        })
        .onConflictDoUpdate({
          target: khotanCaches.name,
          set: {
            scope: cache.scope ?? null,
            ttlSeconds: cache.ttlSeconds ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: khotanCaches.id });
      return { id: rows[0]!.id };
    },

    async getCacheByName(name) {
      const rows = await db
        .select()
        .from(khotanCaches)
        .where(eq(khotanCaches.name, name))
        .limit(1);
      return rows[0] ?? null;
    },

    async getCacheEntry(cacheId, key) {
      const rows = await db
        .select({
          id: khotanCacheEntries.id,
          cacheId: khotanCacheEntries.cacheId,
          key: khotanCacheEntries.key,
          value: khotanCacheEntries.value,
          expiresAt: khotanCacheEntries.expiresAt,
          createdAt: khotanCacheEntries.createdAt,
          updatedAt: khotanCacheEntries.updatedAt,
        })
        .from(khotanCacheEntries)
        .where(
          and(
            eq(khotanCacheEntries.cacheId, cacheId),
            eq(khotanCacheEntries.key, key),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async upsertCacheEntry(entry) {
      const existing = await db
        .select({ id: khotanCacheEntries.id })
        .from(khotanCacheEntries)
        .where(
          and(
            eq(khotanCacheEntries.cacheId, entry.cacheId),
            eq(khotanCacheEntries.key, entry.key),
          ),
        )
        .limit(1);

      const rows = await db
        .insert(khotanCacheEntries)
        .values({
          cacheId: entry.cacheId,
          key: entry.key,
          value: entry.value,
          expiresAt: entry.expiresAt ?? null,
        })
        .onConflictDoUpdate({
          target: [khotanCacheEntries.cacheId, khotanCacheEntries.key],
          set: {
            value: entry.value,
            expiresAt: entry.expiresAt ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: khotanCacheEntries.id });

      return { id: rows[0]!.id, created: existing.length === 0 };
    },

    async deleteCacheEntry(cacheId, key) {
      await db
        .delete(khotanCacheEntries)
        .where(
          and(
            eq(khotanCacheEntries.cacheId, cacheId),
            eq(khotanCacheEntries.key, key),
          ),
        );
    },

    async listResources() {
      const flowCounts = db
        .select({
          resourceId: khotanFlows.resourceId,
          flowCount: count(khotanFlows.id).as("flow_count"),
        })
        .from(khotanFlows)
        .where(sql`${khotanFlows.resourceId} is not null`)
        .groupBy(khotanFlows.resourceId)
        .as("flow_counts");

      const mappingCounts = db
        .select({
          resourceId: khotanMappingsTable.resourceId,
          mappingCount: count(khotanMappingsTable.id).as("mapping_count"),
        })
        .from(khotanMappingsTable)
        .groupBy(khotanMappingsTable.resourceId)
        .as("mapping_counts");

      const rows = await db
        .select({
          id: khotanResources.id,
          name: khotanResources.name,
          connectField: khotanResources.connectField,
          description: khotanResources.description,
          createdAt: khotanResources.createdAt,
          updatedAt: khotanResources.updatedAt,
          flowCount: sql<number>`coalesce(${flowCounts.flowCount}, 0)`,
          mappingCount: sql<number>`coalesce(${mappingCounts.mappingCount}, 0)`,
        })
        .from(khotanResources)
        .leftJoin(flowCounts, eq(khotanResources.id, flowCounts.resourceId))
        .leftJoin(
          mappingCounts,
          eq(khotanResources.id, mappingCounts.resourceId),
        );

      return rows.map((row) => ({
        ...row,
        connectField: deserializeConnectField(row.connectField),
      }));
    },

    async getResource(id) {
      const rows = await db
        .select()
        .from(khotanResources)
        .where(eq(khotanResources.id, id))
        .limit(1);
      if (!rows[0]) return null;
      return {
        ...rows[0],
        connectField: deserializeConnectField(rows[0].connectField),
      };
    },

    async getResourceFlows(resourceId) {
      return db
        .select()
        .from(khotanFlows)
        .where(eq(khotanFlows.resourceId, resourceId));
    },

    async upsertMapping(mapping) {
      if (mapping.id) {
        const mergeRefs = mapping.mergeRefs ?? false;
        const rows = await db
          .update(khotanMappingsTable)
          .set({
            resourceId: mapping.resourceId,
            connectValue: mapping.connectValue,
            refs: mergeRefs
              ? sql`${khotanMappingsTable.refs} || ${JSON.stringify(mapping.refs)}::jsonb`
              : mapping.refs,
            metadata: mapping.metadata ?? null,
            updatedAt: new Date(),
          })
          .where(eq(khotanMappingsTable.id, mapping.id))
          .returning({ id: khotanMappingsTable.id });
        return { id: rows[0]!.id, created: false };
      }

      const existing = await db
        .select({ id: khotanMappingsTable.id })
        .from(khotanMappingsTable)
        .where(
          sql`${khotanMappingsTable.resourceId} = ${mapping.resourceId} and ${khotanMappingsTable.connectValue} = ${mapping.connectValue}`,
        )
        .limit(1);

      const mergeRefs = mapping.mergeRefs ?? true;
      const rows = await db
        .insert(khotanMappingsTable)
        .values({
          resourceId: mapping.resourceId,
          connectValue: mapping.connectValue,
          refs: mapping.refs,
          metadata: mapping.metadata ?? null,
        })
        .onConflictDoUpdate({
          target: [
            khotanMappingsTable.resourceId,
            khotanMappingsTable.connectValue,
          ],
          set: {
            refs: mergeRefs
              ? sql`${khotanMappingsTable.refs} || ${JSON.stringify(mapping.refs)}::jsonb`
              : mapping.refs,
            metadata: mapping.metadata ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: khotanMappingsTable.id });
      return { id: rows[0]!.id, created: existing.length === 0 };
    },

    async getMapping(id) {
      const rows = await db
        .select()
        .from(khotanMappingsTable)
        .where(eq(khotanMappingsTable.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async listMappings({ resourceId, limit, offset, search }) {
      const normalizedSearch = search?.trim();
      const searchPattern = normalizedSearch
        ? `%${normalizedSearch.replace(/[%_]/g, "\\$&")}%`
        : null;

      const filters = searchPattern
        ? sql`${khotanMappingsTable.resourceId} = ${resourceId} and (${khotanMappingsTable.connectValue} ilike ${searchPattern} escape '\\' or ${khotanMappingsTable.refs}::text ilike ${searchPattern} escape '\\' or ${khotanMappingsTable.metadata}::text ilike ${searchPattern} escape '\\')`
        : sql`${khotanMappingsTable.resourceId} = ${resourceId}`;

      const totalRows = await db
        .select({ total: count(khotanMappingsTable.id) })
        .from(khotanMappingsTable)
        .where(filters);

      const rows = await db
        .select()
        .from(khotanMappingsTable)
        .where(filters)
        .orderBy(khotanMappingsTable.connectValue, khotanMappingsTable.id)
        .limit(limit + 1)
        .offset(offset);

      return {
        items: rows.slice(0, limit),
        hasMore: rows.length > limit,
        total: totalRows[0]?.total ?? 0,
      };
    },

    async deleteMapping(id) {
      await db
        .delete(khotanMappingsTable)
        .where(eq(khotanMappingsTable.id, id));
    },

    async lookupMapping(params) {
      if ("connectValue" in params) {
        const rows = await db
          .select()
          .from(khotanMappingsTable)
          .where(
            sql`${khotanMappingsTable.resourceId} = ${params.resourceId} and ${khotanMappingsTable.connectValue} = ${params.connectValue}`,
          )
          .limit(1);
        return rows[0] ?? null;
      }

      const rows = await db
        .select()
        .from(khotanMappingsTable)
        .where(
          sql`${khotanMappingsTable.resourceId} = ${params.resourceId} and ${khotanMappingsTable.refs}->>${params.plugName} = ${params.ref}`,
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async updateFlowResourceId(flowId, resourceId) {
      await db
        .update(khotanFlows)
        .set({ resourceId, updatedAt: new Date() })
        .where(eq(khotanFlows.id, flowId));
    },

    async togglePlugEnabled(plugId, enabled) {
      await db
        .update(khotanPlugs)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(khotanPlugs.id, plugId));
    },

    async toggleFlowEnabled(flowId, enabled) {
      await db
        .update(khotanFlows)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(khotanFlows.id, flowId));
    },

    async toggleWebhookHandlerEnabled(handlerId, enabled) {
      await db
        .update(khotanWebhookHandlers)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(khotanWebhookHandlers.id, handlerId));
    },

    async insertWire(wire) {
      const rows = await db
        .insert(khotanWires)
        .values({
          plugId: wire.plugId,
          remoteId: wire.remoteId,
          callbackUrl: wire.callbackUrl,
          eventTypes: wire.eventTypes,
          status: "active",
        })
        .returning();
      return { id: rows[0]!.id };
    },

    async upsertWire(wire) {
      const existing = await db
        .select({ id: khotanWires.id })
        .from(khotanWires)
        .where(eq(khotanWires.plugId, wire.plugId))
        .limit(1);

      if (existing.length > 0) {
        return { id: existing[0]!.id };
      }

      const rows = await db
        .insert(khotanWires)
        .values({
          plugId: wire.plugId,
          remoteId: "",
          callbackUrl: "",
          eventTypes: [],
          status: "pending",
        })
        .returning();
      return { id: rows[0]!.id };
    },

    async getActiveWire(plugId) {
      const rows = await db
        .select()
        .from(khotanWires)
        .where(
          sql`${khotanWires.plugId} = ${plugId} and ${khotanWires.status} = 'active'`,
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async getPlugWire(plugId) {
      const rows = await db
        .select()
        .from(khotanWires)
        .where(eq(khotanWires.plugId, plugId))
        .limit(1);
      return rows[0] ?? null;
    },

    async getWire(wireId) {
      const rows = await db
        .select()
        .from(khotanWires)
        .where(eq(khotanWires.id, wireId))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateWireStatus(wireId, status) {
      await db
        .update(khotanWires)
        .set({ status, updatedAt: new Date() })
        .where(eq(khotanWires.id, wireId));
    },

    async updateWireDetails(wireId, details) {
      await db
        .update(khotanWires)
        .set({
          remoteId: details.remoteId,
          callbackUrl: details.callbackUrl,
          eventTypes: details.eventTypes,
          status: details.status,
          updatedAt: new Date(),
        })
        .where(eq(khotanWires.id, wireId));
    },

    async getWireMetadata(wireId) {
      const rows = await db
        .select({ metadata: khotanWires.metadata })
        .from(khotanWires)
        .where(eq(khotanWires.id, wireId))
        .limit(1);
      const meta = rows[0]?.metadata;
      if (!meta) return null;
      return typeof meta === "string" ? meta : JSON.stringify(meta);
    },

    async updateWireMetadata(wireId, metadata) {
      await db
        .update(khotanWires)
        .set({ metadata, updatedAt: new Date() })
        .where(eq(khotanWires.id, wireId));
    },

    async getEncryptedVariables(plugId) {
      const rows = await db
        .select({ encryptedVars: khotanPlugs.encryptedVars })
        .from(khotanPlugs)
        .where(eq(khotanPlugs.id, plugId))
        .limit(1);
      return rows[0]?.encryptedVars ?? null;
    },

    async setEncryptedVariables(plugId, encrypted) {
      await db
        .update(khotanPlugs)
        .set({ encryptedVars: encrypted, updatedAt: new Date() })
        .where(eq(khotanPlugs.id, plugId));
    },

    async clearEncryptedVariables(plugId) {
      await db
        .update(khotanPlugs)
        .set({ encryptedVars: null, updatedAt: new Date() })
        .where(eq(khotanPlugs.id, plugId));
    },

    async upsertWebhookHandler(handler) {
      const rows = await db
        .insert(khotanWebhookHandlers)
        .values({
          wireId: handler.wireId,
          name: handler.name,
          type: handler.type,
          destinationPlugId: handler.destinationPlugId ?? null,
        })
        .onConflictDoUpdate({
          target: [khotanWebhookHandlers.wireId, khotanWebhookHandlers.name],
          set: {
            type: handler.type,
            destinationPlugId: handler.destinationPlugId ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: khotanWebhookHandlers.id });
      return { id: rows[0]!.id };
    },

    async listWebhookHandlers(wireId) {
      return db
        .select()
        .from(khotanWebhookHandlers)
        .where(eq(khotanWebhookHandlers.wireId, wireId));
    },

    async getLatestWebhookHandlerRun(handlerId) {
      const rows = await db
        .select({
          id: khotanRuns.id,
          status: khotanRuns.status,
          startedAt: khotanRuns.startedAt,
        })
        .from(khotanRuns)
        .where(eq(khotanRuns.webhookHandlerId, handlerId))
        .orderBy(desc(khotanRuns.startedAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertRun(run) {
      const rows = await db
        .insert(khotanRuns)
        .values({
          flowId: run.flowId ?? null,
          wireId: run.wireId ?? null,
          webhookHandlerId: run.webhookHandlerId ?? null,
          workflowRunId: run.workflowRunId ?? null,
          variant: run.variant,
          source: run.source,
          status: run.status as KhotanRunStatus,
          metadata: run.metadata ?? null,
        })
        .returning({ id: khotanRuns.id });
      return { id: rows[0]!.id };
    },

    async updateRun(runId, updates) {
      await db
        .update(khotanRuns)
        .set({
          status: updates.status,
          workflowRunId: updates.workflowRunId,
          completedAt: updates.completedAt,
          durationMs: updates.durationMs,
          extracted: updates.extracted,
          transformed: updates.transformed,
          created: updates.created,
          updated: updates.updated,
          deleted: updates.deleted,
          failed: updates.failed,
          skipped: updates.skipped,
          error: updates.error,
          metadata: updates.metadata,
        })
        .where(eq(khotanRuns.id, runId));
    },

    async insertWebhookEvent(event) {
      const rows = await db
        .insert(khotanWebhookEvents)
        .values({
          wireId: event.wireId,
          webhookHandlerId: event.webhookHandlerId,
          khotanRunId: event.khotanRunId,
          eventType: event.eventType,
          payload: event.payload,
          headers: event.headers,
        })
        .returning({ id: khotanWebhookEvents.id });
      return { id: rows[0]!.id };
    },

    async listWebhookEventsPage({ limit, offset }) {
      let rows: {
        id: string;
        wireId: string | null;
        webhookHandlerId: string | null;
        khotanRunId: string;
        eventType: string;
        payload: Record<string, unknown>;
        headers: Record<string, string>;
        receivedAt: Date;
      }[];

      try {
        rows = await db
          .select()
          .from(khotanWebhookEvents)
          .orderBy(desc(khotanWebhookEvents.receivedAt))
          .limit(limit + 1)
          .offset(offset);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isLegacyShapeError =
          message.includes(`column "wire_id" does not exist`) ||
          message.includes(`column "webhook_handler_id" does not exist`) ||
          message.includes(`column "headers" does not exist`);

        if (!isLegacyShapeError) {
          throw error;
        }

        const legacyResult = (await db.execute(sql`
          select
            "id",
            null::text as "wire_id",
            null::text as "webhook_handler_id",
            "khotan_run_id",
            "event_type",
            "payload",
            '{}'::jsonb as "headers",
            "received_at"
          from "khotan_webhook_events"
          order by "received_at" desc
          limit ${limit + 1}
          offset ${offset}
        `)) as Record<string, unknown>[] | { rows: Record<string, unknown>[] };

        const rawRows: Record<string, unknown>[] = Array.isArray(legacyResult)
          ? legacyResult
          : "rows" in legacyResult && Array.isArray(legacyResult.rows)
            ? legacyResult.rows
            : [];

        rows = rawRows.map((row) => ({
          id: String(row["id"]),
          wireId: typeof row["wire_id"] === "string" ? row["wire_id"] : null,
          webhookHandlerId:
            typeof row["webhook_handler_id"] === "string"
              ? row["webhook_handler_id"]
              : null,
          khotanRunId: String(row["khotan_run_id"]),
          eventType: String(row["event_type"]),
          payload:
            row["payload"] && typeof row["payload"] === "object"
              ? (row["payload"] as Record<string, unknown>)
              : {},
          headers:
            row["headers"] && typeof row["headers"] === "object"
              ? (row["headers"] as Record<string, string>)
              : {},
          receivedAt:
            row["received_at"] instanceof Date
              ? row["received_at"]
              : new Date(String(row["received_at"])),
        }));
      }

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);

      const handlerIds = [
        ...new Set(
          pageRows
            .map((row) => row.webhookHandlerId)
            .filter((value): value is string => typeof value === "string"),
        ),
      ];
      const runIds = [
        ...new Set(
          pageRows
            .map((row) => row.khotanRunId)
            .filter((value): value is string => typeof value === "string"),
        ),
      ];

      const handlerRows =
        handlerIds.length > 0
          ? await db
              .select({
                id: khotanWebhookHandlers.id,
                name: khotanWebhookHandlers.name,
                type: khotanWebhookHandlers.type,
                plugName: khotanPlugs.name,
              })
              .from(khotanWebhookHandlers)
              .leftJoin(
                khotanWires,
                eq(khotanWebhookHandlers.wireId, khotanWires.id),
              )
              .leftJoin(khotanPlugs, eq(khotanWires.plugId, khotanPlugs.id))
              .where(inArray(khotanWebhookHandlers.id, handlerIds))
          : [];

      const runRows =
        runIds.length > 0
          ? await db
              .select({
                id: khotanRuns.id,
                workflowRunId: khotanRuns.workflowRunId,
                status: khotanRuns.status,
                startedAt: khotanRuns.startedAt,
              })
              .from(khotanRuns)
              .where(inArray(khotanRuns.id, runIds))
          : [];

      const handlerMap = new Map(handlerRows.map((row) => [row.id, row]));
      const runMap = new Map(runRows.map((row) => [row.id, row]));

      return {
        items: pageRows.map((row) => {
          const handler = row.webhookHandlerId
            ? handlerMap.get(row.webhookHandlerId)
            : undefined;
          const run = runMap.get(row.khotanRunId);
          return {
            ...row,
            handlerName: handler?.name ?? null,
            handlerType: handler?.type ?? null,
            plugName: handler?.plugName ?? null,
            workflowRunId: run?.workflowRunId ?? null,
            runStatus: run?.status ?? null,
            runStartedAt: run?.startedAt ?? null,
          };
        }),
        hasMore,
      };
    },

    async updateFlowLastRun(flowId, updates) {
      await db
        .update(khotanFlows)
        .set({
          lastRunAt: updates.lastRunAt,
          lastRunStatus: updates.lastRunStatus,
          updatedAt: new Date(),
        })
        .where(eq(khotanFlows.id, flowId));
    },
  };
}
