import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  __setWorkflowGetRunForTests,
  __setWorkflowGetWritableForTests,
  __setWorkflowStartForTests,
  bindWorkflowPlug,
  catchEvent,
  configureWorkflowRuntime,
  inflow,
  khotanCache,
  khotanRuntimeRegistry,
  khotan,
  outflow,
  relay,
  deriveCliToken,
  sendUpdate,
  toNextJsHandler,
  wire,
  type KhotanAdapter,
  type KhotanConfig,
  type PlugRegistration,
  type ResourceRegistration,
} from "./factory.js";
import { z } from "zod";

function khotanOpen(config: Omit<KhotanConfig, "authorize">) {
  return khotan({ ...config, authorize: false });
}

interface StoredFlow {
  id: string;
  plugId: string;
  name: string;
  type: string;
  schedule: string | null;
  resourceId: string | null;
  enabled: boolean;
  createdAt: Date;
  lastRunAt: Date | null;
  lastRunStatus: "completed" | "partial" | "failed" | "cancelled" | null;
}

interface StoredMapping {
  id: string;
  resourceId: string;
  connectValue: string;
  refs: Record<string, string>;
  metadata: Record<string, unknown> | null;
}

interface StoredRun {
  id: string;
  flowId: string | null;
  wireId: string | null;
  webhookHandlerId: string | null;
  workflowRunId: string | null;
  variant: string;
  source: "scheduled" | "manual" | "webhook";
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  extracted: number;
  transformed: number;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  skipped: number;
  error: string | null;
  metadata: Record<string, unknown> | null;
}

interface StoredWebhookEvent {
  id: string;
  wireId: string;
  webhookHandlerId: string;
  khotanRunId: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  receivedAt: Date;
}

interface StoredCache {
  id: string;
  name: string;
  scope: Record<string, unknown> | null;
  ttlSeconds: number | null;
}

interface StoredCacheEntry {
  id: string;
  cacheId: string;
  key: string;
  value: unknown;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function createMockAdapter(): KhotanAdapter {
  const plugStore = new Map<
    string,
    {
      id: string;
      name: string;
      baseUrl: string;
      authType: string;
      enabled: boolean;
    }
  >();
  const flowStore = new Map<string, StoredFlow>();
  const resourceStore = new Map<
    string,
    {
      id: string;
      name: string;
      connectField: ResourceRegistration["mapping"]["connectField"];
      description: string | null;
    }
  >();
  const mappingStore = new Map<string, StoredMapping>();
  const cacheStore = new Map<string, StoredCache>();
  const cacheEntryStore = new Map<string, StoredCacheEntry>();
  const wireStore = new Map<
    string,
    {
      id: string;
      plugId: string;
      remoteId: string;
      callbackUrl: string;
      eventTypes: string[];
      status: "active" | "disabled" | "pending";
      metadata: string | null;
    }
  >();
  const webhookHandlerStore = new Map<
    string,
    {
      id: string;
      wireId: string;
      name: string;
      type: "catch" | "pass";
      destinationPlugId: string | null;
      enabled: boolean;
    }
  >();
  const runStore = new Map<string, StoredRun>();
  const webhookEventStore = new Map<string, StoredWebhookEvent>();
  const variableStore = new Map<string, string>();
  let plugCounter = 0;
  let flowCounter = 0;
  let resourceCounter = 0;
  let mappingCounter = 0;
  let cacheCounter = 0;
  let cacheEntryCounter = 0;
  let wireCounter = 0;
  let webhookHandlerCounter = 0;
  let runCounter = 0;

  return {
    upsertPlug: vi.fn(async (plug) => {
      const existing = [...plugStore.values()].find(
        (p) => p.name === plug.name,
      );
      if (existing) {
        existing.baseUrl = plug.baseUrl;
        existing.authType = plug.authType;
        return { id: existing.id };
      }
      const id = `plug-${++plugCounter}`;
      plugStore.set(id, { id, ...plug, enabled: true });
      return { id };
    }),

    upsertFlow: vi.fn(async (flow) => {
      const existing = [...flowStore.values()].find(
        (f) => f.plugId === flow.plugId && f.name === flow.name,
      );
      if (existing) {
        existing.type = flow.type;
        existing.schedule = flow.schedule ?? null;
        return { id: existing.id };
      }
      const id = `flow-${++flowCounter}`;
      flowStore.set(id, {
        id,
        plugId: flow.plugId,
        name: flow.name,
        type: flow.type,
        schedule: flow.schedule ?? null,
        resourceId: null,
        enabled: true,
        createdAt: new Date(Date.now() - 60_000),
        lastRunAt: null,
        lastRunStatus: null,
      });
      return { id };
    }),

    listPlugs: vi.fn(async () => {
      return [...plugStore.values()].map((p) => ({
        ...p,
        status: "idle",
        flowCount: [...flowStore.values()].filter(
          (flow) => flow.plugId === p.id,
        ).length,
      }));
    }),

    getPlug: vi.fn(async (id: string) => {
      return plugStore.get(id) ?? null;
    }),

    getPlugFlows: vi.fn(async (plugId: string) => {
      return [...flowStore.values()].filter((flow) => flow.plugId === plugId);
    }),

    getFlow: vi.fn(async (flowId: string) => {
      const flow = flowStore.get(flowId);
      if (!flow) return null;
      return {
        ...flow,
        plugName: plugStore.get(flow.plugId)?.name ?? null,
      };
    }),

    listFlows: vi.fn(async () => {
      return [...flowStore.values()].map((flow) => ({
        ...flow,
        plugName: plugStore.get(flow.plugId)?.name ?? null,
      }));
    }),

    listRuns: vi.fn(async (flowId: string) => {
      return [...runStore.values()].filter((run) => run.flowId === flowId);
    }),

    getRun: vi.fn(async (runId: string) => {
      return runStore.get(runId) ?? null;
    }),

    listRunsPage: vi.fn(
      async ({ limit, offset }: { limit: number; offset: number }) => {
        const rows = [...runStore.values()]
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(offset, offset + limit + 1);
        return {
          items: rows.slice(0, limit).map((run) => ({
            ...run,
            sourceType: run.flowId
              ? "flow"
              : run.webhookHandlerId
                ? "webhook"
                : "unknown",
            sourceName: run.flowId
              ? (flowStore.get(run.flowId)?.name ?? null)
              : null,
            sourceKind: null,
            plugName:
              run.flowId && flowStore.get(run.flowId)
                ? (plugStore.get(flowStore.get(run.flowId)!.plugId)?.name ??
                  null)
                : null,
          })),
          hasMore: rows.length > limit,
        };
      },
    ),

    upsertResource: vi.fn(async (resource) => {
      const existing = [...resourceStore.values()].find(
        (r) => r.name === resource.name,
      );
      if (existing) {
        existing.connectField = resource.connectField;
        existing.description = resource.description ?? null;
        return { id: existing.id };
      }
      const id = `resource-${++resourceCounter}`;
      resourceStore.set(id, {
        id,
        name: resource.name,
        connectField: resource.connectField,
        description: resource.description ?? null,
      });
      return { id };
    }),

    upsertCache: vi.fn(async (cache) => {
      const existing = [...cacheStore.values()].find(
        (c) => c.name === cache.name,
      );
      if (existing) {
        existing.scope =
          (cache.scope as Record<string, unknown> | null) ?? null;
        existing.ttlSeconds = cache.ttlSeconds ?? null;
        return { id: existing.id };
      }
      const id = `cache-${++cacheCounter}`;
      cacheStore.set(id, {
        id,
        name: cache.name,
        scope: (cache.scope as Record<string, unknown> | null) ?? null,
        ttlSeconds: cache.ttlSeconds ?? null,
      });
      return { id };
    }),

    getCacheByName: vi.fn(async (name: string) => {
      return (
        [...cacheStore.values()].find((cache) => cache.name === name) ?? null
      );
    }),

    getCacheEntry: vi.fn(async (cacheId: string, key: string) => {
      return (
        [...cacheEntryStore.values()].find(
          (entry) => entry.cacheId === cacheId && entry.key === key,
        ) ?? null
      );
    }),

    upsertCacheEntry: vi.fn(async (entry) => {
      const existing = [...cacheEntryStore.values()].find(
        (row) => row.cacheId === entry.cacheId && row.key === entry.key,
      );
      if (existing) {
        existing.value = entry.value;
        existing.expiresAt = entry.expiresAt ?? null;
        existing.updatedAt = new Date();
        return { id: existing.id, created: false };
      }
      const id = `cache-entry-${++cacheEntryCounter}`;
      cacheEntryStore.set(id, {
        id,
        cacheId: entry.cacheId,
        key: entry.key,
        value: entry.value,
        expiresAt: entry.expiresAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { id, created: true };
    }),

    deleteCacheEntry: vi.fn(async (cacheId: string, key: string) => {
      const existing = [...cacheEntryStore.values()].find(
        (row) => row.cacheId === cacheId && row.key === key,
      );
      if (existing) {
        cacheEntryStore.delete(existing.id);
      }
    }),

    listResources: vi.fn(async () => {
      return [...resourceStore.values()].map((r) => ({
        ...r,
        flowCount: [...flowStore.values()].filter(
          (flow) => flow.resourceId === r.id,
        ).length,
        mappingCount: [...mappingStore.values()].filter(
          (m) => m.resourceId === r.id,
        ).length,
      }));
    }),

    getResource: vi.fn(async (id: string) => {
      return resourceStore.get(id) ?? null;
    }),

    getResourceFlows: vi.fn(async (resourceId: string) => {
      return [...flowStore.values()].filter(
        (flow) => flow.resourceId === resourceId,
      );
    }),

    upsertMapping: vi.fn(async (mapping) => {
      if (mapping.id) {
        const existing = mappingStore.get(mapping.id);
        if (existing) {
          existing.resourceId = mapping.resourceId;
          existing.connectValue = mapping.connectValue;
          existing.refs =
            mapping.mergeRefs === true
              ? { ...existing.refs, ...mapping.refs }
              : mapping.refs;
          existing.metadata = mapping.metadata ?? null;
          return { id: existing.id, created: false };
        }
      }
      const existing = [...mappingStore.values()].find(
        (m) =>
          m.resourceId === mapping.resourceId &&
          m.connectValue === mapping.connectValue,
      );
      if (existing) {
        existing.refs =
          mapping.mergeRefs === false
            ? mapping.refs
            : { ...existing.refs, ...mapping.refs };
        existing.metadata = mapping.metadata ?? null;
        return { id: existing.id, created: false };
      }
      const id = `mapping-${++mappingCounter}`;
      mappingStore.set(id, {
        id,
        resourceId: mapping.resourceId,
        connectValue: mapping.connectValue,
        refs: mapping.refs,
        metadata: mapping.metadata ?? null,
      });
      return { id, created: true };
    }),

    getMapping: vi.fn(async (id: string) => {
      return mappingStore.get(id) ?? null;
    }),

    listMappings: vi.fn(async ({ resourceId, limit, offset, search }) => {
      const normalizedSearch = search?.toLowerCase().trim();
      const filtered = [...mappingStore.values()]
        .filter((m) => m.resourceId === resourceId)
        .filter((mapping) => {
          if (!normalizedSearch) return true;
          const haystacks = [
            mapping.connectValue,
            ...Object.values(mapping.refs),
            ...Object.values(mapping.metadata ?? {}).filter(
              (value): value is string => typeof value === "string",
            ),
          ].map((value) => value.toLowerCase());
          return haystacks.some((value) => value.includes(normalizedSearch));
        })
        .sort(
          (a, b) =>
            a.connectValue.localeCompare(b.connectValue) ||
            a.id.localeCompare(b.id),
        );

      const rows = filtered.slice(offset, offset + limit + 1);
      return {
        items: rows.slice(0, limit),
        hasMore: rows.length > limit,
        total: filtered.length,
      };
    }),

    deleteMapping: vi.fn(async (id: string) => {
      mappingStore.delete(id);
    }),

    lookupMapping: vi.fn(async (params) => {
      const found = [...mappingStore.values()].find((m) => {
        if (m.resourceId !== params.resourceId) {
          return false;
        }
        if ("connectValue" in params) {
          return m.connectValue === params.connectValue;
        }
        return m.refs[params.plugName] === params.ref;
      });
      return found ?? null;
    }),

    updateFlowResourceId: vi.fn(async (flowId: string, resourceId: string) => {
      const flow = flowStore.get(flowId);
      if (flow) flow.resourceId = resourceId;
    }),

    togglePlugEnabled: vi.fn(async (plugId: string, enabled: boolean) => {
      const plug = plugStore.get(plugId);
      if (plug) plug.enabled = enabled;
    }),

    toggleFlowEnabled: vi.fn(async (flowId: string, enabled: boolean) => {
      const flow = flowStore.get(flowId);
      if (flow) flow.enabled = enabled;
    }),

    toggleWebhookHandlerEnabled: vi.fn(
      async (handlerId: string, enabled: boolean) => {
        const handler = webhookHandlerStore.get(handlerId);
        if (handler) handler.enabled = enabled;
      },
    ),

    insertWire: vi.fn(async (wire) => {
      const id = `wire-${++wireCounter}`;
      wireStore.set(id, {
        id,
        plugId: wire.plugId,
        remoteId: wire.remoteId,
        callbackUrl: wire.callbackUrl,
        eventTypes: wire.eventTypes,
        status: "active",
        metadata: null,
      });
      return { id };
    }),

    upsertWire: vi.fn(async ({ plugId }: { plugId: string }) => {
      const existing = [...wireStore.values()].find(
        (wire) => wire.plugId === plugId,
      );
      if (existing) {
        return { id: existing.id };
      }
      const id = `wire-${++wireCounter}`;
      wireStore.set(id, {
        id,
        plugId,
        remoteId: "",
        callbackUrl: "",
        eventTypes: [],
        status: "pending",
        metadata: null,
      });
      return { id };
    }),

    getActiveWire: vi.fn(async (plugId: string) => {
      return (
        [...wireStore.values()].find(
          (wire) => wire.plugId === plugId && wire.status === "active",
        ) ?? null
      );
    }),

    getPlugWire: vi.fn(async (plugId: string) => {
      return (
        [...wireStore.values()].find((wire) => wire.plugId === plugId) ?? null
      );
    }),

    getWire: vi.fn(async (wireId: string) => {
      return wireStore.get(wireId) ?? null;
    }),

    updateWireStatus: vi.fn(
      async (wireId: string, status: "active" | "disabled" | "pending") => {
        const wire = wireStore.get(wireId);
        if (wire) wire.status = status;
      },
    ),

    updateWireDetails: vi.fn(
      async (
        wireId: string,
        details: {
          remoteId: string;
          callbackUrl: string;
          eventTypes: string[];
          status: "active";
        },
      ) => {
        const wire = wireStore.get(wireId);
        if (wire) {
          wire.remoteId = details.remoteId;
          wire.callbackUrl = details.callbackUrl;
          wire.eventTypes = details.eventTypes;
          wire.status = details.status;
        }
      },
    ),

    getWireMetadata: vi.fn(async (wireId: string) => {
      return wireStore.get(wireId)?.metadata ?? null;
    }),

    updateWireMetadata: vi.fn(async (wireId: string, metadata: string) => {
      const wire = wireStore.get(wireId);
      if (wire) wire.metadata = metadata;
    }),

    getEncryptedVariables: vi.fn(async (plugId: string) => {
      return variableStore.get(plugId) ?? null;
    }),

    setEncryptedVariables: vi.fn(async (plugId: string, encrypted: string) => {
      variableStore.set(plugId, encrypted);
    }),

    clearEncryptedVariables: vi.fn(async (plugId: string) => {
      variableStore.delete(plugId);
    }),

    upsertWebhookHandler: vi.fn(async (handler) => {
      const existing = [...webhookHandlerStore.values()].find(
        (row) => row.wireId === handler.wireId && row.name === handler.name,
      );
      if (existing) {
        existing.type = handler.type;
        existing.destinationPlugId = handler.destinationPlugId ?? null;
        return { id: existing.id };
      }
      const id = `handler-${++webhookHandlerCounter}`;
      webhookHandlerStore.set(id, {
        id,
        wireId: handler.wireId,
        name: handler.name,
        type: handler.type,
        destinationPlugId: handler.destinationPlugId ?? null,
        enabled: true,
      });
      return { id };
    }),

    listWebhookHandlers: vi.fn(async (wireId: string) => {
      return [...webhookHandlerStore.values()].filter(
        (handler) => handler.wireId === wireId,
      );
    }),

    getLatestWebhookHandlerRun: vi.fn(async (handlerId: string) => {
      return (
        [...runStore.values()]
          .filter((run) => run.webhookHandlerId === handlerId)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ??
        null
      );
    }),

    insertRun: vi.fn(async (run) => {
      const id = `run-${++runCounter}`;
      runStore.set(id, {
        id,
        flowId: run.flowId ?? null,
        wireId: run.wireId ?? null,
        webhookHandlerId: run.webhookHandlerId ?? null,
        workflowRunId: run.workflowRunId ?? null,
        variant: run.variant,
        source: run.source,
        status: run.status,
        startedAt: new Date(),
        completedAt: null,
        durationMs: null,
        extracted: 0,
        transformed: 0,
        created: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
        error: null,
        metadata: run.metadata ?? null,
      });
      return { id };
    }),

    updateRun: vi.fn(async (runId, updates) => {
      const run = runStore.get(runId);
      if (run) Object.assign(run, updates);
    }),

    insertWebhookEvent: vi.fn(async (event) => {
      const id = `webhook-event-${webhookEventStore.size + 1}`;
      webhookEventStore.set(id, {
        id,
        wireId: event.wireId,
        webhookHandlerId: event.webhookHandlerId,
        khotanRunId: event.khotanRunId,
        eventType: event.eventType,
        payload: event.payload,
        headers: event.headers,
        receivedAt: new Date(),
      });
      return { id };
    }),

    listWebhookEventsPage: vi.fn(
      async ({ limit, offset }: { limit: number; offset: number }) => {
        const rows = [...webhookEventStore.values()]
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
          .slice(offset, offset + limit + 1);
        return {
          items: rows.slice(0, limit).map((event) => ({
            ...event,
            handlerName: null,
            handlerType: null,
            plugName: null,
            workflowRunId:
              runStore.get(event.khotanRunId)?.workflowRunId ?? null,
            runStatus: runStore.get(event.khotanRunId)?.status ?? null,
            runStartedAt: runStore.get(event.khotanRunId)?.startedAt ?? null,
          })),
          hasMore: rows.length > limit,
        };
      },
    ),

    updateFlowLastRun: vi.fn(async (flowId, updates) => {
      const flow = flowStore.get(flowId);
      if (flow) {
        flow.lastRunAt = updates.lastRunAt;
        flow.lastRunStatus = updates.lastRunStatus;
      }
    }),
  };
}

function makeRequest(path: string, method = "GET", body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://localhost${path}`, init);
}

async function waitForBackgroundTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("bindWorkflowPlug", () => {
  it("reuses workflow-scoped vars for subsequent destination plug requests", async () => {
    const post = vi.fn(
      async (_path: string, options?: Record<string, unknown>) => {
        const vars = (options?.["vars"] ?? {}) as Record<string, string>;
        const setVars = options?.["_setVars"] as
          | ((updates: Record<string, string>) => Promise<void>)
          | undefined;

        if (!vars["_token"]) {
          await setVars?.({ _token: "token-1" });
        }

        return { ok: true };
      },
    );

    const plug = {
      get: vi.fn(),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };

    const ctx = {
      flow: {
        id: "flow-1",
        name: "relay-products",
        plugName: "cin7",
        type: "relay" as const,
        resource: "products",
        to: "pollinate",
      },
      variant: "full",
      vars: {},
      plugVarsByName: {
        pollinate: {},
      },
      khotanRunId: "run-1",
    };

    const boundPlug = bindWorkflowPlug(plug, ctx, "pollinate");
    await boundPlug.post("/products", { body: { name: "One" } });
    await boundPlug.post("/products", { body: { name: "Two" } });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      vars: {},
    });
    expect(post.mock.calls[1]?.[1]).toMatchObject({
      vars: { _token: "token-1" },
    });
    expect(ctx.plugVarsByName["pollinate"]).toEqual({ _token: "token-1" });
  });

  it("batchPost falls back to bound post calls when the plug has no native batchPost", async () => {
    const post = vi.fn(
      async (_path: string, options?: Record<string, unknown>) => ({
        body: options?.["body"],
        vars: options?.["vars"],
      }),
    );
    const plug = {
      get: vi.fn(),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    const ctx = {
      flow: {
        id: "flow-1",
        name: "relay-products",
        plugName: "pollinate",
        type: "relay" as const,
        resource: "products",
      },
      variant: "full",
      vars: { token: "token-1" },
      khotanRunId: "run-1",
    };

    const boundPlug = bindWorkflowPlug(plug, ctx);
    const result = await boundPlug.batchPost(
      "/products",
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      {
        batchSize: 2,
        buildBody: (records) => ({ products: records }),
      },
    );

    expect(result).toEqual([
      {
        body: { products: [{ id: 1 }, { id: 2 }] },
        vars: { token: "token-1" },
      },
      { body: { products: [{ id: 3 }] }, vars: { token: "token-1" } },
    ]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("forwards a request body on delete for batch soft-delete", async () => {
    const del = vi.fn(async () => ({ ok: true }));
    const plug = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: del,
    };

    const ctx = {
      flow: {
        id: "flow-1",
        name: "purge-products",
        plugName: "cin7",
        type: "outflow" as const,
        resource: "products",
        to: null,
      },
      variant: "delta",
      vars: { _token: "abc" },
      khotanRunId: "run-1",
    };

    const boundPlug = bindWorkflowPlug(plug, ctx);
    // Type-checks: delete now accepts a body alongside headers.
    await boundPlug.delete("/products", { body: { ids: [1, 2, 3] } });

    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[1]).toMatchObject({
      body: { ids: [1, 2, 3] },
      vars: { _token: "abc" },
    });
  });
});

describe("khotan factory", () => {
  let adapter: KhotanAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
    __setWorkflowStartForTests(null);
    __setWorkflowGetRunForTests(null);
    __setWorkflowGetWritableForTests(null);
  });

  afterEach(() => {
    // Prevent runtime-helper registrations from leaking between tests, since the
    // deterministic instance id can be shared across configs with the same identity.
    khotanRuntimeRegistry.clear();
  });

  it("uses configured workflow runtime helpers for stream updates", async () => {
    const chunks: string[] = [];
    const getWritable = vi.fn((options?: { namespace?: string }) => {
      expect(options).toEqual({ namespace: "relay" });
      return new WritableStream<string>({
        write(chunk) {
          chunks.push(chunk);
        },
      });
    });

    configureWorkflowRuntime({ getWritable });

    await sendUpdate("relayed products", { namespace: "relay" });

    expect(getWritable).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(1);
    const payload = JSON.parse(chunks[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "log",
      message: "relayed products",
    });
    expect(typeof payload["timestamp"]).toBe("string");
  });

  describe("registration validation", () => {
    it("throws on duplicate plug names", () => {
      const plugs: PlugRegistration[] = [
        {
          name: "stripe",
          plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
        },
        {
          name: "stripe",
          plug: { baseUrl: "https://api.stripe.com/v2", authType: "bearer" },
        },
      ];

      expect(() => khotanOpen({ adapter, plugs })).toThrow(
        'Duplicate plug name: "stripe"',
      );
    });

    it("accepts an empty plugs array", () => {
      const instance = khotanOpen({ adapter, plugs: [] });
      expect(instance).toHaveProperty("handler");
      expect(instance).toHaveProperty("init");
    });

    it("accepts unique plug names", () => {
      const plugs: PlugRegistration[] = [
        {
          name: "stripe",
          plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
        },
        {
          name: "github",
          plug: { baseUrl: "https://api.github.com", authType: "bearer" },
        },
      ];

      expect(() => khotanOpen({ adapter, plugs })).not.toThrow();
    });

    it("throws on duplicate resource names", () => {
      const resources: ResourceRegistration[] = [
        { name: "products", mapping: { connectField: "sku" } },
        { name: "products", mapping: { connectField: "product_id" } },
      ];

      expect(() => khotanOpen({ adapter, plugs: [], resources })).toThrow(
        'Duplicate resource name: "products"',
      );
    });

    it("throws when flow references unknown resource", () => {
      const plugs: PlugRegistration[] = [
        {
          name: "shopify",
          plug: { baseUrl: "https://shopify.com", authType: "bearer" },
          flows: [
            { name: "products-inflow", type: "inflow", resource: "products" },
          ],
        },
      ];

      expect(() => khotanOpen({ adapter, plugs })).toThrow(
        'Flow "products-inflow" references unknown resource: "products"',
      );
    });

    it("throws on duplicate cache names", () => {
      expect(() =>
        khotanOpen({
          adapter,
          plugs: [],
          caches: [
            { name: "products-snapshot" },
            { name: "products-snapshot" },
          ],
        }),
      ).toThrow('Duplicate cache name: "products-snapshot"');
    });

    it("throws when cache scope references an unknown plug", () => {
      expect(() =>
        khotanOpen({
          adapter,
          plugs: [],
          caches: [
            {
              name: "products-snapshot",
              scope: { plug: "cin7" },
            },
          ],
        }),
      ).toThrow('Cache "products-snapshot" references unknown plug: "cin7"');
    });

    it("throws when cache scope references an unknown flow", () => {
      expect(() =>
        khotanOpen({
          adapter,
          plugs: [
            {
              name: "cin7",
              plug: { baseUrl: "https://cin7.com", authType: "bearer" },
            },
          ],
          caches: [
            {
              name: "products-snapshot",
              scope: { flow: "missing-flow" },
            },
          ],
        }),
      ).toThrow(
        'Cache "products-snapshot" references unknown flow: "missing-flow"',
      );
    });

    it("accepts flow with valid resource reference", () => {
      const resources: ResourceRegistration[] = [
        { name: "products", mapping: { connectField: "sku" } },
      ];
      const plugs: PlugRegistration[] = [
        {
          name: "shopify",
          plug: { baseUrl: "https://shopify.com", authType: "bearer" },
          flows: [
            { name: "products-inflow", type: "inflow", resource: "products" },
          ],
        },
      ];

      expect(() => khotanOpen({ adapter, plugs, resources })).not.toThrow();
    });

    it("accepts composite connectField resources", () => {
      expect(() =>
        khotanOpen({
          adapter,
          plugs: [],
          resources: [
            {
              name: "customers",
              mapping: { connectField: ["tenantId", "email"] },
            },
          ],
        }),
      ).not.toThrow();
    });

    it("throws when a resource declares an unknown participant plug", () => {
      expect(() =>
        khotanOpen({
          adapter,
          plugs: [],
          resources: [
            {
              name: "customers",
              mapping: {
                connectField: "email",
                plugs: {
                  cin7: { uniqueIdentifier: "id" },
                },
              },
            },
          ],
        }),
      ).toThrow('Resource "customers" references unknown plug: "cin7"');
    });

    it("throws when a resource plug declaration is malformed", () => {
      expect(() =>
        khotanOpen({
          adapter,
          plugs: [
            {
              name: "cin7",
              plug: { baseUrl: "https://cin7.com", authType: "bearer" },
            },
          ],
          resources: [
            {
              name: "customers",
              mapping: {
                connectField: "email",
                plugs: {
                  cin7: {} as { uniqueIdentifier: string },
                },
              },
            },
          ],
        }),
      ).toThrow(
        'Resource "customers" must declare exactly one uniqueIdentifier for plug "cin7"',
      );
    });
  });

  describe("init()", () => {
    it("upserts registered plugs and flows", async () => {
      const plugs: PlugRegistration[] = [
        {
          name: "stripe",
          plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
          flows: [
            { name: "products-inflow", type: "inflow", schedule: "0 * * * *" },
            { name: "invoices-inflow", type: "inflow" },
          ],
        },
      ];

      const instance = khotanOpen({ adapter, plugs });
      await instance.init();

      expect(adapter.upsertPlug).toHaveBeenCalledWith({
        name: "stripe",
        baseUrl: "https://api.stripe.com",
        authType: "bearer",
      });
      expect(adapter.upsertFlow).toHaveBeenCalledTimes(2);
      expect(adapter.upsertFlow).toHaveBeenCalledWith({
        plugId: "plug-1",
        name: "products-inflow",
        type: "inflow",
        schedule: "0 * * * *",
      });
      expect(adapter.upsertFlow).toHaveBeenCalledWith({
        plugId: "plug-1",
        name: "invoices-inflow",
        type: "inflow",
        schedule: null,
      });
    });

    it("runs only once even when called multiple times", async () => {
      const plugs: PlugRegistration[] = [
        {
          name: "stripe",
          plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
        },
      ];

      const instance = khotanOpen({ adapter, plugs });
      await Promise.all([instance.init(), instance.init(), instance.init()]);

      expect(adapter.upsertPlug).toHaveBeenCalledTimes(1);
    });

    it("handles plugs without flows", async () => {
      const plugs: PlugRegistration[] = [
        {
          name: "stripe",
          plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
        },
      ];

      const instance = khotanOpen({ adapter, plugs });
      await instance.init();

      expect(adapter.upsertPlug).toHaveBeenCalledTimes(1);
      expect(adapter.upsertFlow).not.toHaveBeenCalled();
    });

    it("upserts resources before plugs and flows", async () => {
      const resources: ResourceRegistration[] = [
        {
          name: "products",
          mapping: { connectField: "sku" },
          description: "Product catalog",
        },
      ];
      const plugs: PlugRegistration[] = [
        {
          name: "shopify",
          plug: { baseUrl: "https://shopify.com", authType: "bearer" },
          flows: [
            { name: "products-inflow", type: "inflow", resource: "products" },
          ],
        },
      ];

      const instance = khotanOpen({ adapter, plugs, resources });
      await instance.init();

      expect(adapter.upsertResource).toHaveBeenCalledWith({
        name: "products",
        connectField: "sku",
        description: "Product catalog",
      });
      expect(adapter.upsertResource).toHaveBeenCalledBefore(
        adapter.upsertPlug as ReturnType<typeof vi.fn>,
      );
    });

    it("links flows to resource_id after upserting", async () => {
      const resources: ResourceRegistration[] = [
        { name: "products", mapping: { connectField: "sku" } },
      ];
      const plugs: PlugRegistration[] = [
        {
          name: "shopify",
          plug: { baseUrl: "https://shopify.com", authType: "bearer" },
          flows: [
            { name: "products-inflow", type: "inflow", resource: "products" },
          ],
        },
      ];

      const instance = khotanOpen({ adapter, plugs, resources });
      await instance.init();

      expect(adapter.updateFlowResourceId).toHaveBeenCalledWith(
        "flow-1",
        "resource-1",
      );
    });

    it("does not call updateFlowResourceId for flows without resource", async () => {
      const plugs: PlugRegistration[] = [
        {
          name: "stripe",
          plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
          flows: [{ name: "payments", type: "inflow" }],
        },
      ];

      const instance = khotanOpen({ adapter, plugs });
      await instance.init();

      expect(adapter.updateFlowResourceId).not.toHaveBeenCalled();
    });

    it("upserts registered caches with normalized ttl", async () => {
      const validated = khotanOpen({
        adapter,
        plugs: [
          {
            name: "cin7",
            plug: { baseUrl: "https://cin7.com", authType: "bearer" },
            flows: [{ name: "relay-products", type: "relay", to: "pollinate" }],
          },
          {
            name: "pollinate",
            plug: { baseUrl: "https://pollinate.tech", authType: "bearer" },
          },
        ],
        resources: [{ name: "products", mapping: { connectField: "sku" } }],
        caches: [
          {
            name: "cin7-products-snapshot",
            scope: {
              plug: "cin7",
              resource: "products",
              flow: "relay-products",
            },
            ttl: "6h",
          },
        ],
      });

      await validated.init();

      expect(adapter.upsertCache).toHaveBeenCalledWith({
        name: "cin7-products-snapshot",
        scope: {
          plug: "cin7",
          resource: "products",
          flow: "relay-products",
        },
        ttlSeconds: 21600,
      });
    });
  });

  describe("cache runtime", () => {
    it("supports programmatic cache reads, overwrites, and deletes", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [],
        caches: [{ name: "products-snapshot" }],
      });

      await instance
        .cache("products-snapshot")
        .set("all-products", { count: 2 });
      await expect(
        instance
          .cache("products-snapshot")
          .get<{ count: number }>("all-products"),
      ).resolves.toEqual({ count: 2 });

      await instance
        .cache("products-snapshot")
        .set("all-products", { count: 3 });
      await expect(
        instance
          .cache("products-snapshot")
          .get<{ count: number }>("all-products"),
      ).resolves.toEqual({ count: 3 });

      await instance.cache("products-snapshot").delete("all-products");
      await expect(
        instance.cache("products-snapshot").get("all-products"),
      ).resolves.toBeNull();
    });

    it("treats expired cache entries as misses", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T10:00:00Z"));

      try {
        const instance = khotanOpen({
          adapter,
          plugs: [],
          caches: [{ name: "relay-checkpoint", ttl: "1s" }],
        });

        await instance.cache("relay-checkpoint").set("last-successful-run", {
          cursor: "run-1",
        });
        await expect(
          instance
            .cache("relay-checkpoint")
            .get<{ cursor: string }>("last-successful-run"),
        ).resolves.toEqual({ cursor: "run-1" });

        vi.advanceTimersByTime(1_001);

        await expect(
          instance.cache("relay-checkpoint").get("last-successful-run"),
        ).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("deleting a missing cache key is safe", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [],
        caches: [{ name: "webhook-dedupe" }],
      });

      await expect(
        instance.cache("webhook-dedupe").delete("event:missing"),
      ).resolves.toBeUndefined();
    });
  });

  describe("handler routing", () => {
    let instance: ReturnType<typeof khotan>;

    beforeEach(() => {
      instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
            flows: [{ name: "products", type: "inflow" }],
          },
        ],
      });
    });

    it("GET /api/khotan/plugs lists plugs", async () => {
      const res = await instance.handler(makeRequest("/api/khotan/plugs"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data[0]).toHaveProperty("name", "stripe");
      expect(data[0]).toHaveProperty("flowCount");
    });

    it("GET /api/khotan/plugs/:id returns plug with flows", async () => {
      await instance.init();
      const res = await instance.handler(
        makeRequest("/api/khotan/plugs/plug-1"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("stripe");
      expect(data.flows).toHaveLength(1);
    });

    it("surfaces relay flows on their destination plug", async () => {
      const relayInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "fresh-uat",
            plug: { baseUrl: "https://fresh.example", authType: "bearer" },
            flows: [
              {
                name: "fresh-products-relay",
                type: "relay",
                to: "invoice-agent",
              },
            ],
          },
          {
            name: "invoice-agent",
            plug: { baseUrl: "https://invoice.example", authType: "bearer" },
          },
        ],
      });

      await relayInstance.init();

      const plugsRes = await relayInstance.handler(
        makeRequest("/api/khotan/plugs"),
      );
      expect(plugsRes.status).toBe(200);
      const plugsData = (await plugsRes.json()) as Record<string, unknown>[];
      expect(
        plugsData.find((plug) => plug["name"] === "fresh-uat"),
      ).toMatchObject({ flowCount: 1 });
      expect(
        plugsData.find((plug) => plug["name"] === "invoice-agent"),
      ).toMatchObject({ flowCount: 1 });

      const flowsRes = await relayInstance.handler(
        makeRequest("/api/khotan/flows"),
      );
      expect(flowsRes.status).toBe(200);
      const flowsData = (await flowsRes.json()) as Record<string, unknown>[];
      expect(flowsData[0]).toMatchObject({
        name: "fresh-products-relay",
        type: "relay",
        plugName: "fresh-uat",
        to: "invoice-agent",
        destinationPlugId: "plug-2",
        destinationPlugName: "invoice-agent",
      });

      const destinationRes = await relayInstance.handler(
        makeRequest("/api/khotan/plugs/plug-2"),
      );
      expect(destinationRes.status).toBe(200);
      const destinationData = (await destinationRes.json()) as {
        flows: Record<string, unknown>[];
      };
      expect(destinationData.flows).toHaveLength(1);
      expect(destinationData.flows[0]).toMatchObject({
        name: "fresh-products-relay",
        destinationPlugId: "plug-2",
      });
    });

    it("GET /api/khotan/plugs/:id returns 404 for unknown plug", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/plugs/nonexistent"),
      );
      expect(res.status).toBe(404);
    });

    it("GET /api/khotan/flows lists flows", async () => {
      const res = await instance.handler(makeRequest("/api/khotan/flows"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it("GET /api/khotan/flows/:id/runs lists runs", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it("supports cache entry GET/POST/DELETE routes", async () => {
      const cacheInstance = khotanOpen({
        adapter,
        plugs: [],
        caches: [{ name: "products-snapshot", ttl: "1h" }],
      });

      const createRes = await cacheInstance.handler(
        makeRequest(
          "/api/khotan/caches/products-snapshot/all-products",
          "POST",
          {
            value: { count: 4 },
          },
        ),
      );
      expect(createRes.status).toBe(200);
      await expect(createRes.json()).resolves.toMatchObject({
        cache: "products-snapshot",
        key: "all-products",
        value: { count: 4 },
      });

      const getRes = await cacheInstance.handler(
        makeRequest("/api/khotan/caches/products-snapshot/all-products"),
      );
      expect(getRes.status).toBe(200);
      await expect(getRes.json()).resolves.toMatchObject({
        cache: "products-snapshot",
        key: "all-products",
        value: { count: 4 },
      });

      const deleteRes = await cacheInstance.handler(
        makeRequest(
          "/api/khotan/caches/products-snapshot/all-products",
          "DELETE",
        ),
      );
      expect(deleteRes.status).toBe(204);

      const missingRes = await cacheInstance.handler(
        makeRequest("/api/khotan/caches/products-snapshot/all-products"),
      );
      expect(missingRes.status).toBe(404);
    });

    it("GET /api/khotan/runs returns paginated log rows", async () => {
      await adapter.insertRun({
        flowId: "flow-1",
        variant: "default",
        source: "manual",
        status: "completed",
      });
      await adapter.insertRun({
        flowId: "flow-1",
        variant: "default",
        source: "manual",
        status: "failed",
      });
      await adapter.insertRun({
        flowId: "flow-1",
        variant: "delta",
        source: "manual",
        status: "running",
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/runs?limit=2"),
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.items).toHaveLength(2);
      expect(data.page).toMatchObject({
        limit: 2,
        offset: 0,
        hasMore: true,
        prevOffset: 0,
        nextOffset: 2,
      });
      expect(data.items[0]).toHaveProperty("sourceType");
    });

    it("GET /api/khotan/webhook-events returns paginated log rows", async () => {
      const { id: runId1 } = await adapter.insertRun({
        flowId: "flow-1",
        variant: "webhook",
        source: "webhook",
        status: "completed",
      });
      const { id: runId2 } = await adapter.insertRun({
        flowId: "flow-1",
        variant: "webhook",
        source: "webhook",
        status: "running",
      });

      await adapter.insertWebhookEvent({
        wireId: "wire-1",
        webhookHandlerId: "handler-1",
        khotanRunId: runId1,
        eventType: "order.created",
        payload: { id: "evt-1" },
        headers: { "x-test": "1" },
      });
      await adapter.insertWebhookEvent({
        wireId: "wire-1",
        webhookHandlerId: "handler-1",
        khotanRunId: runId2,
        eventType: "order.updated",
        payload: { id: "evt-2" },
        headers: { "x-test": "2" },
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/webhook-events?limit=1"),
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.page).toMatchObject({
        limit: 1,
        offset: 0,
        hasMore: true,
        prevOffset: 0,
        nextOffset: 1,
      });
      expect(data.items[0]).toHaveProperty("eventType");
    });

    it("POST /api/khotan/flows/:id/runs executes a flow and updates run lifecycle", async () => {
      const run = vi.fn(async () => ({
        extracted: 2,
        transformed: 2,
        created: 1,
        updated: 1,
        metadata: { source: "test" },
      }));
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST", {
          variant: "delta",
          body: { limit: 10 },
        }),
      );

      expect(res.status).toBe(200);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "delta",
          body: { limit: 10 },
          flow: expect.objectContaining({ id: "flow-1", name: "products" }),
        }),
      );
      expect(adapter.insertRun).toHaveBeenCalledWith({
        flowId: "flow-1",
        variant: "delta",
        source: "manual",
        status: "running",
        metadata: { limit: 10 },
      });
      expect(adapter.updateRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          status: "completed",
          extracted: 2,
          transformed: 2,
          created: 1,
          updated: 1,
          failed: 0,
          metadata: { source: "test" },
        }),
      );
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "completed" }),
      );
    });

    it("POST /api/khotan/flows/:id/runs preserves start body metadata when the run result has none", async () => {
      const run = vi.fn(async () => ({
        extracted: 1,
      }));
      const flowInstance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST", {
          body: { target: "sku_123", mode: "manual" },
        }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-1",
        status: "completed",
        metadata: { target: "sku_123", mode: "manual" },
      });
      expect(adapter.insertRun).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { target: "sku_123", mode: "manual" },
        }),
      );
      expect(adapter.updateRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          status: "completed",
          metadata: { target: "sku_123", mode: "manual" },
        }),
      );
    });

    it("POST /api/khotan/flows/:id/runs exposes ctx.finalize as a race-idempotent escape hatch", async () => {
      let releaseTerminalUpdate = () => {};
      let resolveTerminalUpdateStarted = () => {};
      const terminalUpdateGate = new Promise<void>((resolve) => {
        releaseTerminalUpdate = resolve;
      });
      const terminalUpdateStarted = new Promise<void>((resolve) => {
        resolveTerminalUpdateStarted = resolve;
      });
      const originalUpdateRun = adapter.updateRun;
      adapter.updateRun = vi.fn(async (runId, updates) => {
        if (updates.completedAt) {
          resolveTerminalUpdateStarted();
          await terminalUpdateGate;
        }
        await originalUpdateRun(runId, updates);
      });
      const onComplete = vi.fn();
      const run = vi.fn(
        async (ctx: { finalize: (result: unknown) => Promise<void> }) => {
          const first = ctx.finalize({
            extracted: 4,
            updated: 3,
            metadata: { finalized: true },
          });
          await terminalUpdateStarted;
          const second = ctx.finalize({
            extracted: 99,
            updated: 99,
            metadata: { overwritten: true },
          });
          await Promise.resolve();
          releaseTerminalUpdate();
          await Promise.all([first, second]);
          return {
            extracted: 100,
            updated: 100,
            metadata: { returned: true },
          };
        },
      );
      const flowInstance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [
              {
                name: "products",
                type: "inflow",
                variants: { default: { onComplete } },
                run,
              },
            ],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-1",
        status: "completed",
        extracted: 4,
        updated: 3,
        metadata: { finalized: true },
      });
      const terminalUpdates = adapter.updateRun.mock.calls.filter(
        ([, updates]) => updates.completedAt,
      );
      expect(terminalUpdates).toHaveLength(1);
      expect(terminalUpdates[0]).toEqual([
        "run-1",
        expect.objectContaining({
          status: "completed",
          extracted: 4,
          updated: 3,
          metadata: { finalized: true },
        }),
      ]);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("POST /api/khotan/flows/:id/runs threads a skipped counter through the run response and updateRun", async () => {
      const run = vi.fn(async () => ({
        skipped: 5,
      }));
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-1",
        // skipped is neutral: a run with only skipped records still completes.
        status: "completed",
        skipped: 5,
      });
      expect(adapter.updateRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          status: "completed",
          skipped: 5,
        }),
      );
    });

    it("POST /api/khotan/flows/:id/runs marks successful runs with failed records as partial", async () => {
      const run = vi.fn(async () => ({
        extracted: 10,
        transformed: 10,
        updated: 8,
        failed: 2,
        metadata: { source: "test" },
      }));
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-1",
        status: "partial",
        failed: 2,
      });
      expect(adapter.updateRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          status: "partial",
          failed: 2,
        }),
      );
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "partial" }),
      );
    });

    it("POST /api/khotan/flows/:id/runs honors explicit terminal status from run results", async () => {
      const run = vi.fn(async () => ({
        status: "cancelled" as const,
        extracted: 5,
        updated: 2,
        error: "Stopped by preflight",
        metadata: { reason: "preflight" },
      }));
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-1",
        status: "cancelled",
        extracted: 5,
        updated: 2,
        error: "Stopped by preflight",
      });
      expect(adapter.updateRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          status: "cancelled",
          error: "Stopped by preflight",
          metadata: { reason: "preflight" },
        }),
      );
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "cancelled" }),
      );
    });

    it("POST /api/khotan/flows/:id/runs reconciles returned step workflow results", async () => {
      const workflow = vi.fn(async () => {
        const loadStep = async () => {
          "use step";
          return {
            extracted: 3,
            transformed: 3,
            updated: 3,
            failed: 1,
            metadata: { source: "workflow" },
          };
        };
        return loadStep();
      });
      let returnValue: Promise<unknown>;
      const startWorkflow = vi.fn(async (workflowFn, args) => {
        returnValue = Promise.resolve(workflowFn(args[0]));
        return {
          runId: "workflow-run-1",
          returnValue,
        };
      });
      __setWorkflowStartForTests(startWorkflow);

      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST", {
          variant: "full",
        }),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-1",
        flowId: "flow-1",
        workflowRunId: "workflow-run-1",
        status: "running",
      });
      expect(startWorkflow).toHaveBeenCalledTimes(1);
      expect(startWorkflow).toHaveBeenCalledWith(workflow, [
        expect.objectContaining({
          khotanRunId: "run-1",
          khotanInstanceId: expect.any(String),
          variant: "full",
          flow: expect.objectContaining({
            id: "flow-1",
            name: "products",
            plugName: "stripe",
          }),
          plugVarsByName: {
            stripe: {},
          },
        }),
      ]);

      await returnValue;
      await waitForBackgroundTasks();

      const runsRes = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs"),
      );
      const runs = (await runsRes.json()) as Array<Record<string, unknown>>;
      expect(runs[0]).toMatchObject({
        id: "run-1",
        status: "partial",
        workflowRunId: "workflow-run-1",
        extracted: 3,
        transformed: 3,
        updated: 3,
        failed: 1,
        metadata: { source: "workflow" },
      });
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "partial" }),
      );
    });

    it("POST /api/khotan/flows/:id/runs does not expose ctx.finalize on durable workflow args", async () => {
      let workflowCtx: Record<string, unknown> | undefined;
      const workflow = vi.fn(async (ctx: Record<string, unknown>) => {
        workflowCtx = ctx;
        return {
          created: 2,
          metadata: { returned: true },
        };
      });
      let returnValue: Promise<unknown>;
      const startWorkflow = vi.fn(async (workflowFn, args) => {
        returnValue = Promise.resolve(workflowFn(args[0]));
        return {
          runId: "workflow-run-1",
          returnValue,
        };
      });
      __setWorkflowStartForTests(startWorkflow);

      const flowInstance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      expect(res.status).toBe(200);
      await returnValue;
      await waitForBackgroundTasks();

      expect(workflowCtx).not.toHaveProperty("finalize");
      expect(startWorkflow.mock.calls[0]?.[1]?.[0]).not.toHaveProperty(
        "finalize",
      );
      const terminalUpdates = adapter.updateRun.mock.calls.filter(
        ([, updates]) => updates.completedAt,
      );
      expect(terminalUpdates).toHaveLength(1);
      expect(terminalUpdates[0]).toEqual([
        "run-1",
        expect.objectContaining({
          status: "completed",
          created: 2,
          metadata: { returned: true },
        }),
      ]);
    });

    it("POST /api/khotan/flows/:id/runs includes destination plug vars for relay workflows", async () => {
      const workflow = vi.fn(async () => undefined);
      const returnValue = Promise.resolve(undefined);
      const startWorkflow = vi.fn(async () => ({
        runId: "workflow-run-1",
        returnValue,
      }));
      __setWorkflowStartForTests(startWorkflow);

      const flowInstance = khotanOpen({
        adapter,
        secret: "test-secret",
        plugs: [
          {
            name: "cin7",
            plug: {
              baseUrl: "https://api.cin7.com",
              authType: "basic",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [
              {
                name: "products-relay",
                type: "relay",
                to: "pollinate",
                workflow,
              },
            ],
          },
          {
            name: "pollinate",
            plug: {
              baseUrl: "https://api.pollinate.tech",
              authType: "custom",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.setVars("cin7", { username: "cin7-user" });
      await flowInstance.setVars("pollinate", { username: "pollinate-user" });

      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST", {
          variant: "full",
        }),
      );

      expect(res.status).toBe(200);
      expect(startWorkflow).toHaveBeenCalledWith(workflow, [
        expect.objectContaining({
          khotanInstanceId: expect.any(String),
          flow: expect.objectContaining({
            id: "flow-1",
            plugName: "cin7",
            to: "pollinate",
          }),
          vars: { username: "cin7-user" },
          plugVarsByName: {
            cin7: { username: "cin7-user" },
            pollinate: { username: "pollinate-user" },
          },
        }),
      ]);
    });

    it("relay workflows can read and bust cache entries through khotanCache()", async () => {
      let returnValue: Promise<unknown> | undefined;
      const workflow = vi.fn(async (ctx: { khotanInstanceId: string }) => {
        const cache = khotanCache(ctx, "cin7-products-snapshot");
        const before = await cache.get("all-products");
        expect(before).toBeNull();

        await cache.set("all-products", {
          skus: ["SKU-1", "SKU-2"],
        });
        const after = await cache.get<{
          skus: string[];
        }>("all-products");
        await cache.delete("all-products");

        return {
          metadata: {
            cachedCount: after?.skus.length ?? 0,
          },
        };
      });
      const startWorkflow = vi.fn(async (workflowFn, args) => {
        returnValue = Promise.resolve(workflowFn(args[0]));
        return {
          runId: "workflow-run-1",
          returnValue,
        };
      });
      __setWorkflowStartForTests(startWorkflow);

      const relayInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "cin7",
            plug: {
              baseUrl: "https://api.cin7.com",
              authType: "basic",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [
              {
                name: "products-relay",
                type: "relay",
                to: "pollinate",
                workflow,
              },
            ],
          },
          {
            name: "pollinate",
            plug: {
              baseUrl: "https://api.pollinate.tech",
              authType: "custom",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
        caches: [{ name: "cin7-products-snapshot", scope: { plug: "cin7" } }],
      });

      const res = await relayInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST", {
          variant: "full",
        }),
      );
      expect(res.status).toBe(200);

      await returnValue;
      await waitForBackgroundTasks();

      expect(workflow).toHaveBeenCalledTimes(1);
      await expect(
        relayInstance.cache("cin7-products-snapshot").get("all-products"),
      ).resolves.toBeNull();
    });

    it("resolves khotanCache() across isolates via the deterministic instance id", async () => {
      // Capture the khotanInstanceId serialized into the workflow context when a
      // flow is started, modelling the original process.
      let capturedInstanceId: string | undefined;
      const startWorkflow = vi.fn(async (_workflowFn, args) => {
        capturedInstanceId = args[0].khotanInstanceId as string;
        return {
          runId: "workflow-run-1",
          returnValue: Promise.resolve(undefined),
        };
      });
      __setWorkflowStartForTests(startWorkflow);

      const config = {
        adapter,
        plugs: [
          {
            name: "cin7",
            plug: {
              baseUrl: "https://api.cin7.com",
              authType: "basic",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [
              {
                name: "products-relay",
                type: "relay" as const,
                to: "pollinate",
                workflow: vi.fn(async () => undefined),
              },
            ],
          },
          {
            name: "pollinate",
            plug: {
              baseUrl: "https://api.pollinate.tech",
              authType: "custom",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
        caches: [{ name: "cin7-products-snapshot", scope: { plug: "cin7" } }],
      };

      // Instance A: original process. Start a flow to capture the serialized id.
      const instanceA = khotanOpen(config);
      const res = await instanceA.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST", {
          variant: "full",
        }),
      );
      expect(res.status).toBe(200);
      expect(capturedInstanceId).toBeDefined();
      const capturedId = capturedInstanceId as string;

      // Simulate the step isolate: the original process is gone (clear the
      // registry), then the flow module is re-imported, re-running khotan(config).
      khotanRuntimeRegistry.clear();
      const instanceB = khotanOpen(config);
      expect(instanceB).toBeDefined();

      // The re-imported instance must have registered under the SAME id so the
      // serialized context id still resolves.
      const cache = khotanCache(
        { khotanInstanceId: capturedId },
        "cin7-products-snapshot",
      );
      await cache.set("all-products", { skus: ["SKU-1", "SKU-2"] });
      const after = await cache.get<{ skus: string[] }>("all-products");
      expect(after?.skus).toEqual(["SKU-1", "SKU-2"]);
      await cache.delete("all-products");
      await expect(cache.get("all-products")).resolves.toBeNull();
    });

    it("falls back to the sole registered instance on a registry miss", async () => {
      khotanRuntimeRegistry.clear();

      khotanOpen({
        adapter,
        plugs: [
          {
            name: "cin7",
            plug: {
              baseUrl: "https://api.cin7.com",
              authType: "basic",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
        caches: [{ name: "cin7-products-snapshot", scope: { plug: "cin7" } }],
      });

      const cache = khotanCache(
        { khotanInstanceId: "cfg_doesnotexist" },
        "cin7-products-snapshot",
      );
      await cache.set("k", { v: 1 });
      await expect(cache.get<{ v: number }>("k")).resolves.toEqual({ v: 1 });
      await cache.delete("k");
    });

    it("pass workflows can write dedupe markers through khotanCache()", async () => {
      const passWorkflow = vi.fn(
        async (ctx: { eventType: string; khotanInstanceId: string }) => {
          await khotanCache(ctx, "webhook-dedupe").set(
            `event:${String(ctx.eventType)}:evt-1`,
            { seen: true },
          );
        },
      );
      __setWorkflowStartForTests(
        vi.fn(async (workflowFn, args) => ({
          runId: "workflow-run-1",
          returnValue: Promise.resolve(workflowFn(args[0])),
        })),
      );

      const webhookInstance = khotanOpen({
        adapter,
        secret: "test-secret",
        plugs: [
          {
            name: "pollinate",
            plug: {
              baseUrl: "https://api.pollinate.tech",
              authType: "custom",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["order.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "remote-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onVerify: vi.fn(async () => true),
              },
            ],
            passes: [
              {
                type: "pass",
                name: "pollinate-order-created-pass",
                to: "slack",
                events: ["order.created"],
                workflow: passWorkflow,
              },
            ],
          },
          {
            name: "slack",
            plug: {
              baseUrl: "https://hooks.slack.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
        caches: [{ name: "webhook-dedupe", scope: { plug: "pollinate" } }],
      });

      const response = await webhookInstance.handler(
        makeRequest("/api/khotan/webhook/pollinate", "POST", {
          type: "order.created",
          id: "evt-1",
        }),
      );
      expect(response.status).toBe(202);

      await waitForBackgroundTasks();
      await waitForBackgroundTasks();

      expect(passWorkflow).toHaveBeenCalledTimes(1);
      await expect(
        webhookInstance
          .cache("webhook-dedupe")
          .get<{ seen: boolean }>("event:order.created:evt-1"),
      ).resolves.toEqual({ seen: true });
    });

    it("fires onWebhookReceived after verification accepts an inbound webhook", async () => {
      const onWebhookReceived = vi.fn();
      const webhookInstance = khotan({
        adapter,
        onWebhookReceived,
        authorize: false,
        plugs: [
          {
            name: "pollinate",
            plug: {
              baseUrl: "https://api.pollinate.tech",
              authType: "custom",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["order.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "remote-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onVerify: vi.fn(async () => true),
              },
            ],
          },
        ],
      });

      const response = await webhookInstance.handler(
        makeRequest("/api/khotan/webhook/pollinate", "POST", {
          type: "order.created",
          id: "evt-1",
        }),
      );

      expect(response.status).toBe(202);
      expect(onWebhookReceived).toHaveBeenCalledTimes(1);
      expect(onWebhookReceived.mock.calls[0]![0]).toMatchObject({
        plug: { name: "pollinate" },
        wireId: "wire-1",
        eventType: "order.created",
        event: { type: "order.created", id: "evt-1" },
      });
    });

    it("creates and deletes manual wires without subscription hooks", async () => {
      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "cin7",
            plug: {
              baseUrl: "https://api.cin7.com",
              authType: "basic",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                mode: "manual",
                events: ["order.created"],
              },
            ],
          },
        ],
      });

      const wireRecord = await instance
        .wire("cin7")
        .create("https://app.example.com/api/khotan/webhook/cin7");

      expect(wireRecord).toMatchObject({
        remoteId: "manual:cin7",
        callbackUrl: "https://app.example.com/api/khotan/webhook/cin7",
        status: "active",
      });

      await instance.wire("cin7").delete(String(wireRecord["id"]));
      await expect(instance.wire("cin7").get()).resolves.toMatchObject({
        status: "disabled",
      });
    });

    it("rejects deleting an explicit wire id from another plug", async () => {
      const graphUnsubscribe = vi.fn(async () => undefined);
      const slackUnsubscribe = vi.fn(async () => undefined);
      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "graph",
            plug: {
              baseUrl: "https://graph.microsoft.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "graph-sub-1" })),
                onUnsubscribe: graphUnsubscribe,
              },
            ],
          },
          {
            name: "slack",
            plug: {
              baseUrl: "https://slack.com/api",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "slack-sub-1" })),
                onUnsubscribe: slackUnsubscribe,
              },
            ],
          },
        ],
      });

      await instance
        .wire("graph")
        .create("https://app.example.com/api/khotan/webhook/graph");
      const slackWire = await instance
        .wire("slack")
        .create("https://app.example.com/api/khotan/webhook/slack");
      vi.mocked(adapter.updateWireStatus).mockClear();

      await expect(
        instance.wire("graph").delete(String(slackWire["id"])),
      ).rejects.toThrow('Wire for plug "graph" not found');
      expect(graphUnsubscribe).not.toHaveBeenCalled();
      expect(slackUnsubscribe).not.toHaveBeenCalled();
      expect(adapter.updateWireStatus).not.toHaveBeenCalled();
      await expect(instance.wire("slack").get()).resolves.toMatchObject({
        id: slackWire["id"],
        remoteId: "slack-sub-1",
        status: "active",
      });
    });

    it("DELETE /api/khotan/wires/:plugName returns 404 for another plug's wire id", async () => {
      const graphUnsubscribe = vi.fn(async () => undefined);
      const slackUnsubscribe = vi.fn(async () => undefined);
      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "graph",
            plug: {
              baseUrl: "https://graph.microsoft.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "graph-sub-1" })),
                onUnsubscribe: graphUnsubscribe,
              },
            ],
          },
          {
            name: "slack",
            plug: {
              baseUrl: "https://slack.com/api",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "slack-sub-1" })),
                onUnsubscribe: slackUnsubscribe,
              },
            ],
          },
        ],
      });

      await instance
        .wire("graph")
        .create("https://app.example.com/api/khotan/webhook/graph");
      const slackWire = await instance
        .wire("slack")
        .create("https://app.example.com/api/khotan/webhook/slack");
      vi.mocked(adapter.updateWireStatus).mockClear();

      const response = await instance.handler(
        makeRequest("/api/khotan/wires/graph", "DELETE", {
          wireId: slackWire["id"],
        }),
      );

      await expect(response.json()).resolves.toEqual({
        error: 'Wire for plug "graph" not found',
      });
      expect(response.status).toBe(404);
      expect(graphUnsubscribe).not.toHaveBeenCalled();
      expect(slackUnsubscribe).not.toHaveBeenCalled();
      expect(adapter.updateWireStatus).not.toHaveBeenCalled();
      await expect(instance.wire("slack").get()).resolves.toMatchObject({
        id: slackWire["id"],
        remoteId: "slack-sub-1",
        status: "active",
      });
    });

    it("DELETE /api/khotan/wires/:plugName keeps provider disconnect errors non-404", async () => {
      const graphUnsubscribe = vi.fn(async () => {
        throw new Error("Provider subscription not found");
      });
      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "graph",
            plug: {
              baseUrl: "https://graph.microsoft.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "graph-sub-1" })),
                onUnsubscribe: graphUnsubscribe,
              },
            ],
          },
        ],
      });

      const graphWire = await instance
        .wire("graph")
        .create("https://app.example.com/api/khotan/webhook/graph");
      vi.mocked(adapter.updateWireStatus).mockClear();

      const response = await instance.handler(
        makeRequest("/api/khotan/wires/graph", "DELETE", {
          wireId: graphWire["id"],
        }),
      );

      await expect(response.json()).resolves.toEqual({
        error: "Provider subscription not found",
      });
      expect(response.status).toBe(500);
      expect(graphUnsubscribe).toHaveBeenCalledTimes(1);
      expect(adapter.updateWireStatus).not.toHaveBeenCalled();
      await expect(instance.wire("graph").get()).resolves.toMatchObject({
        id: graphWire["id"],
        remoteId: "graph-sub-1",
        status: "active",
      });
    });

    it("renews managed wires and carries expiry through wire metadata", async () => {
      const onRenew = vi.fn(async (ctx) => {
        expect(ctx.remoteId).toBe("graph-sub-1");
        expect(ctx.callbackUrl).toBe(
          "https://app.example.com/api/khotan/webhook/graph",
        );
        expect(ctx.expiresAt).toBe("2026-07-01T00:00:00.000Z");
        await ctx.setWireVars({ renewalToken: "next-token" });
        return {
          remoteId: "graph-sub-2",
          expiresAt: "2026-07-02T00:00:00.000Z",
        };
      });

      const instance = khotan({
        adapter,
        authorize: false,
        secret: "test-secret",
        plugs: [
          {
            name: "graph",
            plug: {
              baseUrl: "https://graph.microsoft.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({
                  remoteId: "graph-sub-1",
                  expiresAt: new Date("2026-07-01T00:00:00.000Z"),
                })),
                onUnsubscribe: vi.fn(async () => undefined),
                onRenew,
              },
            ],
          },
        ],
      });

      const created = await instance
        .wire("graph")
        .create("https://app.example.com/api/khotan/webhook/graph");
      const renewed = await instance.wire("graph").renew(String(created["id"]));

      expect(onRenew).toHaveBeenCalledTimes(1);
      expect(renewed).toMatchObject({
        id: created["id"],
        remoteId: "graph-sub-2",
        status: "active",
      });
    });

    it("rejects renewing an explicit wire id from another plug", async () => {
      const graphRenew = vi.fn(async () => ({ remoteId: "graph-sub-2" }));
      const slackRenew = vi.fn(async () => ({ remoteId: "slack-sub-2" }));
      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "graph",
            plug: {
              baseUrl: "https://graph.microsoft.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "graph-sub-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onRenew: graphRenew,
              },
            ],
          },
          {
            name: "slack",
            plug: {
              baseUrl: "https://slack.com/api",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "slack-sub-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onRenew: slackRenew,
              },
            ],
          },
        ],
      });

      await instance
        .wire("graph")
        .create("https://app.example.com/api/khotan/webhook/graph");
      const slackWire = await instance
        .wire("slack")
        .create("https://app.example.com/api/khotan/webhook/slack");

      await expect(
        instance.wire("graph").renew(String(slackWire["id"])),
      ).rejects.toThrow('Wire for plug "graph" not found');
      expect(graphRenew).not.toHaveBeenCalled();
    });

    it("POST /api/khotan/wires/:plugName/renew returns 404 for another plug's wire id", async () => {
      const graphRenew = vi.fn(async () => ({ remoteId: "graph-sub-2" }));
      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "graph",
            plug: {
              baseUrl: "https://graph.microsoft.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "graph-sub-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onRenew: graphRenew,
              },
            ],
          },
          {
            name: "slack",
            plug: {
              baseUrl: "https://slack.com/api",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "slack-sub-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onRenew: vi.fn(async () => ({ remoteId: "slack-sub-2" })),
              },
            ],
          },
        ],
      });

      await instance
        .wire("graph")
        .create("https://app.example.com/api/khotan/webhook/graph");
      const slackWire = await instance
        .wire("slack")
        .create("https://app.example.com/api/khotan/webhook/slack");

      const response = await instance.handler(
        makeRequest("/api/khotan/wires/graph/renew", "POST", {
          wireId: slackWire["id"],
        }),
      );

      await expect(response.json()).resolves.toEqual({
        error: 'Wire for plug "graph" not found',
      });
      expect(response.status).toBe(404);
      expect(graphRenew).not.toHaveBeenCalled();
    });

    it("POST /api/khotan/wires/:plugName/renew keeps provider renewal errors non-404", async () => {
      const graphRenew = vi.fn(async () => {
        throw new Error("Provider subscription not found");
      });
      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "graph",
            plug: {
              baseUrl: "https://graph.microsoft.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["message.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "graph-sub-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onRenew: graphRenew,
              },
            ],
          },
        ],
      });

      const graphWire = await instance
        .wire("graph")
        .create("https://app.example.com/api/khotan/webhook/graph");
      vi.mocked(adapter.updateWireDetails).mockClear();

      const response = await instance.handler(
        makeRequest("/api/khotan/wires/graph/renew", "POST", {
          wireId: graphWire["id"],
        }),
      );

      await expect(response.json()).resolves.toEqual({
        error: "Provider subscription not found",
      });
      expect(response.status).toBe(500);
      expect(graphRenew).toHaveBeenCalledTimes(1);
      expect(adapter.updateWireDetails).not.toHaveBeenCalled();
      await expect(instance.wire("graph").get()).resolves.toMatchObject({
        id: graphWire["id"],
        remoteId: "graph-sub-1",
        status: "active",
      });
    });

    it("passes schema-parsed events to catch workflows", async () => {
      const schema = z.object({
        type: z.literal("order.created"),
        data: z.object({ orderId: z.string() }),
      });
      const catchWorkflow = vi.fn(
        async (ctx: {
          event: z.infer<typeof schema>;
          eventType: string;
          khotanInstanceId: string;
        }) => {
          expect(ctx.event.data.orderId).toBe("ord_123");
        },
      );
      __setWorkflowStartForTests(
        vi.fn(async (workflowFn, args) => ({
          runId: "workflow-run-1",
          returnValue: Promise.resolve(workflowFn(args[0])),
        })),
      );

      const instance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "shopify",
            plug: {
              baseUrl: "https://shopify.example",
              authType: "custom",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            wires: [
              {
                events: ["order.created"],
                onSubscribe: vi.fn(async () => ({ remoteId: "remote-1" })),
                onUnsubscribe: vi.fn(async () => undefined),
                onVerify: vi.fn(async () => true),
              },
            ],
            catches: [
              {
                type: "catch",
                name: "shopify-order-created",
                events: ["order.created"],
                schema,
                workflow: catchWorkflow,
              },
            ],
          },
        ],
      });

      const response = await instance.handler(
        makeRequest("/api/khotan/webhook/shopify", "POST", {
          type: "order.created",
          data: { orderId: "ord_123" },
        }),
      );

      expect(response.status).toBe(202);
      await waitForBackgroundTasks();
      await waitForBackgroundTasks();
      expect(catchWorkflow).toHaveBeenCalledTimes(1);
    });

    it("POST /api/khotan/flows/:id/runs reconciles failed workflow runs", async () => {
      const workflow = vi.fn(async () => undefined);
      const returnValue = Promise.reject(new Error("workflow boom"));
      const startWorkflow = vi.fn(async () => ({
        runId: "workflow-run-1",
        returnValue,
      }));
      __setWorkflowStartForTests(startWorkflow);

      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      expect(res.status).toBe(200);
      await returnValue.catch(() => undefined);
      await waitForBackgroundTasks();

      const runsRes = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs"),
      );
      const runs = (await runsRes.json()) as Array<Record<string, unknown>>;
      expect(runs[0]).toMatchObject({
        id: "run-1",
        status: "failed",
        workflowRunId: "workflow-run-1",
        failed: 1,
        error: "workflow boom",
      });
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "failed" }),
      );
    });

    it("GET /api/khotan/runs/:id returns live workflow status", async () => {
      const workflow = vi.fn(async () => undefined);
      __setWorkflowStartForTests(
        vi.fn(async () => ({
          runId: "workflow-run-1",
          returnValue: new Promise(() => {}),
        })),
      );
      __setWorkflowGetRunForTests(
        vi.fn(() => ({
          status: Promise.resolve("running"),
        })),
      );

      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      const res = await flowInstance.handler(
        makeRequest("/api/khotan/runs/run-1"),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-1",
        workflowRunId: "workflow-run-1",
        workflowStatus: "running",
      });
    });

    it("GET /api/khotan/runs/:id reconciles terminal workflow status", async () => {
      __setWorkflowGetRunForTests(
        vi.fn(() => ({
          status: Promise.resolve("completed"),
        })),
      );
      const onFlowRunComplete = vi.fn();

      const flowInstance = khotan({
        adapter,
        authorize: false,
        onFlowRunComplete,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow" }],
          },
        ],
      });

      await flowInstance.init();
      const { id } = await adapter.insertRun({
        flowId: "flow-1",
        workflowRunId: "workflow-run-1",
        variant: "default",
        source: "manual",
        status: "running",
      });
      const run = await adapter.getRun(id);
      expect(run).not.toBeNull();
      run!["startedAt"] = new Date(Date.now() - 60_000);

      const res = await flowInstance.handler(
        makeRequest(`/api/khotan/runs/${id}`),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        id,
        status: "completed",
        workflowRunId: "workflow-run-1",
        workflowStatus: "completed",
        error: null,
      });
      expect(body["completedAt"]).toEqual(expect.any(String));
      expect(body["durationMs"]).toEqual(expect.any(Number));
      await expect(adapter.getRun(id)).resolves.toMatchObject({
        status: "completed",
        error: null,
      });
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "completed" }),
      );
      expect(onFlowRunComplete).toHaveBeenCalledTimes(1);
      expect(onFlowRunComplete.mock.calls[0]![1]).toMatchObject({
        id,
        status: "completed",
      });
    });

    it("GET /api/khotan/runs reconciles terminal workflow status in run lists", async () => {
      __setWorkflowGetRunForTests(
        vi.fn(() => ({
          status: Promise.resolve("failed"),
        })),
      );
      const onFlowRunFailed = vi.fn();

      const flowInstance = khotan({
        adapter,
        authorize: false,
        onFlowRunFailed,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow" }],
          },
        ],
      });

      await flowInstance.init();
      const { id } = await adapter.insertRun({
        flowId: "flow-1",
        workflowRunId: "workflow-run-1",
        variant: "default",
        source: "manual",
        status: "running",
      });
      const run = await adapter.getRun(id);
      expect(run).not.toBeNull();
      run!["startedAt"] = new Date(Date.now() - 60_000);

      const res = await flowInstance.handler(makeRequest("/api/khotan/runs"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(body.items[0]).toMatchObject({
        id,
        status: "failed",
        failed: 1,
        workflowStatus: "failed",
        error: "Workflow reported failed before khotan observed completion",
      });
      await expect(adapter.getRun(id)).resolves.toMatchObject({
        status: "failed",
        failed: 1,
      });
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "failed" }),
      );
      expect(onFlowRunFailed).toHaveBeenCalledTimes(1);
      expect(onFlowRunFailed.mock.calls[0]![1]).toMatchObject({
        id,
        status: "failed",
        error: "Workflow reported failed before khotan observed completion",
      });
    });

    it("GET /api/khotan/runs/:id/stream returns the workflow stream", async () => {
      const encoder = new TextEncoder();
      const workflow = vi.fn(async () => undefined);
      __setWorkflowStartForTests(
        vi.fn(async () => ({
          runId: "workflow-run-1",
          returnValue: new Promise(() => {}),
        })),
      );
      __setWorkflowGetRunForTests(
        vi.fn(() => ({
          getReadable: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('{"message":"hello"}\n'));
                controller.close();
              },
            }),
        })),
      );

      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      const res = await flowInstance.handler(
        makeRequest("/api/khotan/runs/run-1/stream?startIndex=-50"),
      );
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toContain("hello");
    });

    it("POST /api/khotan/runs/:id/cancel cancels workflow runs", async () => {
      const cancel = vi.fn(async () => undefined);
      const workflow = vi.fn(async () => undefined);
      __setWorkflowStartForTests(
        vi.fn(async () => ({
          runId: "workflow-run-1",
          returnValue: new Promise(() => {}),
        })),
      );
      __setWorkflowGetRunForTests(vi.fn(() => ({ cancel })));

      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      const res = await flowInstance.handler(
        makeRequest("/api/khotan/runs/run-1/cancel", "POST"),
      );
      expect(res.status).toBe(200);
      expect(cancel).toHaveBeenCalled();

      const runsRes = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs"),
      );
      const runs = (await runsRes.json()) as Array<Record<string, unknown>>;
      expect(runs[0]).toMatchObject({
        id: "run-1",
        status: "cancelled",
        error: "Cancelled",
      });
    });

    it("does not overwrite a manually cancelled workflow run when the workflow later settles", async () => {
      const cancel = vi.fn(async () => undefined);
      const workflow = vi.fn(async () => undefined);
      let resolveWorkflow!: (value: unknown) => void;
      const returnValue = new Promise<unknown>((resolve) => {
        resolveWorkflow = resolve;
      });
      __setWorkflowStartForTests(
        vi.fn(async () => ({
          runId: "workflow-run-1",
          returnValue,
        })),
      );
      __setWorkflowGetRunForTests(vi.fn(() => ({ cancel })));
      const onFlowRunComplete = vi.fn();
      const onFlowRunFailed = vi.fn();

      const flowInstance = khotan({
        adapter,
        authorize: false,
        onFlowRunComplete,
        onFlowRunFailed,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );
      await flowInstance.handler(
        makeRequest("/api/khotan/runs/run-1/cancel", "POST"),
      );

      resolveWorkflow({ updated: 9 });
      await returnValue;
      await waitForBackgroundTasks();

      const runsRes = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs"),
      );
      const runs = (await runsRes.json()) as Array<Record<string, unknown>>;
      expect(runs[0]).toMatchObject({
        id: "run-1",
        status: "cancelled",
        error: "Cancelled",
        updated: 0,
      });
      expect(onFlowRunFailed).toHaveBeenCalledTimes(1);
      expect(onFlowRunFailed.mock.calls[0]![1]).toMatchObject({
        id: "run-1",
        status: "cancelled",
        error: "Cancelled",
      });
      expect(onFlowRunComplete).not.toHaveBeenCalled();
      expect(adapter.updateRun).not.toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("does not overwrite a reconciled stuck workflow run when the workflow later settles", async () => {
      const workflow = vi.fn(async () => undefined);
      let resolveWorkflow!: (value: unknown) => void;
      const returnValue = new Promise<unknown>((resolve) => {
        resolveWorkflow = resolve;
      });
      __setWorkflowStartForTests(
        vi.fn(async () => ({
          runId: "workflow-run-1",
          returnValue,
        })),
      );
      const onFlowRunComplete = vi.fn();
      const onFlowRunFailed = vi.fn();

      const flowInstance = khotan({
        adapter,
        authorize: false,
        onFlowRunComplete,
        onFlowRunFailed,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );
      const run = await adapter.getRun("run-1");
      expect(run).not.toBeNull();
      run!["startedAt"] = new Date(Date.now() - 60 * 60_000);

      const result = await flowInstance.reconcileStuckRuns({
        olderThanMs: 10 * 60_000,
        error: "stale worker",
      });
      expect(result).toMatchObject({
        checked: 1,
        reconciled: 1,
        skipped: 0,
      });

      resolveWorkflow({ updated: 9 });
      await returnValue;
      await waitForBackgroundTasks();

      const runsRes = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs"),
      );
      const runs = (await runsRes.json()) as Array<Record<string, unknown>>;
      expect(runs[0]).toMatchObject({
        id: "run-1",
        status: "failed",
        error: "stale worker",
        failed: 1,
        updated: 0,
      });
      expect(onFlowRunFailed).toHaveBeenCalledTimes(1);
      expect(onFlowRunFailed.mock.calls[0]![1]).toMatchObject({
        id: "run-1",
        status: "failed",
        error: "stale worker",
      });
      expect(onFlowRunComplete).not.toHaveBeenCalled();
      expect(adapter.updateRun).not.toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("POST /api/khotan/flows/:id/runs reconciles cancelled workflow runs", async () => {
      const workflow = vi.fn(async () => undefined);
      const cancelError = Object.assign(
        new Error("Workflow run was cancelled"),
        {
          name: "WorkflowRunCancelledError",
        },
      );
      const returnValue = Promise.reject(cancelError);
      __setWorkflowStartForTests(
        vi.fn(async () => ({
          runId: "workflow-run-1",
          returnValue,
        })),
      );

      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", workflow }],
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );
      await returnValue.catch(() => undefined);
      await waitForBackgroundTasks();

      const runsRes = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs"),
      );
      const runs = (await runsRes.json()) as Array<Record<string, unknown>>;
      expect(runs[0]).toMatchObject({
        id: "run-1",
        status: "cancelled",
        workflowRunId: "workflow-run-1",
        failed: 0,
      });
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "cancelled" }),
      );
    });

    it("POST /api/khotan/runs/:id/retry starts another flow run", async () => {
      const run = vi.fn(async () => ({ updated: 1 }));
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      await flowInstance.init();
      await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST", {
          variant: "delta",
        }),
      );

      const res = await flowInstance.handler(
        makeRequest("/api/khotan/runs/run-1/retry", "POST"),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "run-2",
        flowId: "flow-1",
        status: "completed",
        variant: "delta",
      });
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("flow().start starts a registered flow by name", async () => {
      const run = vi.fn(async () => ({
        extracted: 1,
        transformed: 1,
        updated: 1,
      }));
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      const data = await flowInstance.flow("products").start({
        variant: "delta",
        body: { limit: 5 },
      });

      expect(data).toMatchObject({
        id: "run-1",
        flowId: "flow-1",
        status: "completed",
        variant: "delta",
        extracted: 1,
        transformed: 1,
        updated: 1,
      });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "delta",
          body: { limit: 5 },
          flow: expect.objectContaining({ id: "flow-1", name: "products" }),
        }),
      );
    });

    it("flow().start requires plugName when a flow name is ambiguous", async () => {
      const run = vi.fn(async () => undefined);
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
          {
            name: "shopify",
            plug: {
              baseUrl: "https://shopify.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "outflow", run }],
          },
        ],
      });

      await expect(flowInstance.flow("products").start()).rejects.toThrow(
        'Flow "products" is registered on multiple plugs',
      );

      await expect(
        flowInstance.flow("products", { plugName: "shopify" }).start(),
      ).resolves.toMatchObject({ flowId: "flow-2", status: "completed" });
    });

    it("GET /api/khotan/cron triggers due scheduled flows", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T12:10:00Z"));

      try {
        const dueRun = vi.fn(async () => ({ updated: 1 }));
        const laterRun = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "products",
                  type: "inflow",
                  schedule: "*/10 * * * *",
                  run: dueRun,
                },
                {
                  name: "orders",
                  type: "inflow",
                  schedule: "11 * * * *",
                  run: laterRun,
                },
              ],
            },
          ],
        });

        const res = await flowInstance.handler(makeRequest("/api/khotan/cron"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.triggered).toHaveLength(1);
        expect(data.triggered[0]).toMatchObject({
          flowId: "flow-1",
          flowName: "products",
          plugName: "stripe",
        });
        expect(data.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              flowId: "flow-2",
              reason: "not_due",
            }),
          ]),
        );
        expect(dueRun).toHaveBeenCalledTimes(1);
        expect(laterRun).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron skips disabled flows", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T12:10:00Z"));

      try {
        const run = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "products",
                  type: "inflow",
                  schedule: "* * * * *",
                  run,
                },
              ],
            },
          ],
        });

        await flowInstance.init();
        await adapter.toggleFlowEnabled("flow-1", false);

        const res = await flowInstance.handler(makeRequest("/api/khotan/cron"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.triggered).toHaveLength(0);
        expect(data.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              flowId: "flow-1",
              reason: "disabled",
            }),
          ]),
        );
        expect(run).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron does not re-trigger flows already run this heartbeat", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T12:10:00Z"));

      try {
        const run = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "products",
                  type: "inflow",
                  schedule: "* * * * *",
                  run,
                },
              ],
            },
          ],
        });

        const first = await flowInstance.handler(
          makeRequest("/api/khotan/cron"),
        );
        expect(first.status).toBe(200);
        const second = await flowInstance.handler(
          makeRequest("/api/khotan/cron"),
        );
        expect(second.status).toBe(200);
        const data = await second.json();
        expect(data.triggered).toHaveLength(0);
        expect(data.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              flowId: "flow-1",
              reason: "not_due",
            }),
          ]),
        );
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron requires CRON_SECRET when configured", async () => {
      const originalSecret = process.env["CRON_SECRET"];
      process.env["CRON_SECRET"] = "top-secret";

      try {
        const run = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "products",
                  type: "inflow",
                  schedule: "* * * * *",
                  run,
                },
              ],
            },
          ],
        });

        const denied = await flowInstance.handler(
          makeRequest("/api/khotan/cron"),
        );
        expect(denied.status).toBe(401);

        const allowed = await flowInstance.handler(
          new Request("http://localhost/api/khotan/cron", {
            headers: {
              Authorization: "Bearer top-secret",
            },
          }),
        );
        expect(allowed.status).toBe(200);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        if (originalSecret !== undefined) {
          process.env["CRON_SECRET"] = originalSecret;
        } else {
          delete process.env["CRON_SECRET"];
        }
      }
    });

    it("GET /api/khotan/cron catches up overdue flow from late heartbeat", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T02:30:00Z"));

      try {
        const run = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "daily-sync",
                  type: "inflow",
                  schedule: "0 2 * * *",
                  run,
                },
              ],
            },
          ],
        });

        await flowInstance.init();
        await adapter.updateFlowLastRun("flow-1", {
          lastRunAt: new Date("2026-06-12T02:00:00Z"),
          lastRunStatus: "completed",
        });

        const res = await flowInstance.handler(makeRequest("/api/khotan/cron"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.triggered).toHaveLength(1);
        expect(data.triggered[0]).toMatchObject({
          flowName: "daily-sync",
          plugName: "stripe",
        });
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron triggers multiple overdue flows in one heartbeat", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T02:30:00Z"));

      try {
        const inflowRun = vi.fn(async () => ({ updated: 1 }));
        const outflowRun = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "inflow",
                  type: "inflow",
                  schedule: "0 2 * * *",
                  run: inflowRun,
                },
                {
                  name: "outflow",
                  type: "outflow",
                  schedule: "15 2 * * *",
                  run: outflowRun,
                },
              ],
            },
          ],
        });

        await flowInstance.init();
        await adapter.updateFlowLastRun("flow-1", {
          lastRunAt: new Date("2026-06-12T02:00:00Z"),
          lastRunStatus: "completed",
        });
        await adapter.updateFlowLastRun("flow-2", {
          lastRunAt: new Date("2026-06-12T02:15:00Z"),
          lastRunStatus: "completed",
        });

        const res = await flowInstance.handler(makeRequest("/api/khotan/cron"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.triggered).toHaveLength(2);
        expect(data.triggered).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ flowName: "inflow" }),
            expect.objectContaining({ flowName: "outflow" }),
          ]),
        );
        expect(inflowRun).toHaveBeenCalledTimes(1);
        expect(outflowRun).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron does not re-trigger after failed run advances lastRunAt", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T02:30:00Z"));

      try {
        const run = vi.fn(async () => {
          throw new Error("something broke");
        });
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "daily-sync",
                  type: "inflow",
                  schedule: "0 2 * * *",
                  run,
                },
              ],
            },
          ],
        });

        await flowInstance.init();
        await adapter.updateFlowLastRun("flow-1", {
          lastRunAt: new Date("2026-06-12T02:00:00Z"),
          lastRunStatus: "completed",
        });

        const first = await flowInstance.handler(
          makeRequest("/api/khotan/cron"),
        );
        const firstData = await first.json();
        expect(firstData.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              flowName: "daily-sync",
              reason: "trigger_failed",
            }),
          ]),
        );

        const second = await flowInstance.handler(
          makeRequest("/api/khotan/cron"),
        );
        const secondData = await second.json();
        expect(secondData.triggered).toHaveLength(0);
        expect(secondData.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              flowName: "daily-sync",
              reason: "not_due",
            }),
          ]),
        );
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron triggers overdue hourly flow", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T04:00:00Z"));

      try {
        const run = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "hourly-sync",
                  type: "inflow",
                  schedule: "0 * * * *",
                  run,
                },
              ],
            },
          ],
        });

        await flowInstance.init();
        await adapter.updateFlowLastRun("flow-1", {
          lastRunAt: new Date("2026-06-13T02:55:00Z"),
          lastRunStatus: "completed",
        });

        const res = await flowInstance.handler(makeRequest("/api/khotan/cron"));
        const data = await res.json();
        expect(data.triggered).toHaveLength(1);
        expect(data.triggered[0]).toMatchObject({ flowName: "hourly-sync" });
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron skips flow that ran recently within its interval", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T02:30:00Z"));

      try {
        const run = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "daily-sync",
                  type: "inflow",
                  schedule: "0 2 * * *",
                  run,
                },
              ],
            },
          ],
        });

        await flowInstance.init();
        await adapter.updateFlowLastRun("flow-1", {
          lastRunAt: new Date("2026-06-13T02:05:00Z"),
          lastRunStatus: "completed",
        });

        const res = await flowInstance.handler(makeRequest("/api/khotan/cron"));
        const data = await res.json();
        expect(data.triggered).toHaveLength(0);
        expect(data.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              flowName: "daily-sync",
              reason: "not_due",
            }),
          ]),
        );
        expect(run).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("GET /api/khotan/cron triggers flow at exact schedule match time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T02:00:00Z"));

      try {
        const run = vi.fn(async () => ({ updated: 1 }));
        const flowInstance = khotanOpen({
          adapter,
          plugs: [
            {
              name: "stripe",
              plug: {
                baseUrl: "https://api.stripe.com",
                authType: "bearer",
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                patch: vi.fn(),
                delete: vi.fn(),
              },
              flows: [
                {
                  name: "daily-sync",
                  type: "inflow",
                  schedule: "0 2 * * *",
                  run,
                },
              ],
            },
          ],
        });

        await flowInstance.init();
        await adapter.updateFlowLastRun("flow-1", {
          lastRunAt: new Date("2026-06-12T02:00:00Z"),
          lastRunStatus: "completed",
        });

        const res = await flowInstance.handler(makeRequest("/api/khotan/cron"));
        const data = await res.json();
        expect(data.triggered).toHaveLength(1);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("POST /api/khotan/flows/:id/runs records failed flow runs", async () => {
      const run = vi.fn(async () => {
        throw new Error("boom");
      });
      const flowInstance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            flows: [{ name: "products", type: "inflow", run }],
          },
        ],
      });

      await flowInstance.init();
      const res = await flowInstance.handler(
        makeRequest("/api/khotan/flows/flow-1/runs", "POST"),
      );

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data).toMatchObject({
        id: "run-1",
        flowId: "flow-1",
        status: "failed",
        error: "boom",
      });
      expect(adapter.updateRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          status: "failed",
          failed: 1,
          error: "boom",
        }),
      );
      expect(adapter.updateFlowLastRun).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ lastRunStatus: "failed" }),
      );
    });

    it("returns 404 for unknown routes", async () => {
      const res = await instance.handler(makeRequest("/api/khotan/unknown"));
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data).toHaveProperty("error", "Not found");
    });

    it("returns 404 for POST requests (no POST routes defined)", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/plugs", "POST"),
      );
      expect(res.status).toBe(404);
    });

    it("initializes lazily on first handler call", async () => {
      expect(adapter.upsertPlug).not.toHaveBeenCalled();
      await instance.handler(makeRequest("/api/khotan/plugs"));
      expect(adapter.upsertPlug).toHaveBeenCalledTimes(1);
    });

    it("handles empty plugs list", async () => {
      const emptyInstance = khotanOpen({ adapter, plugs: [] });
      const res = await emptyInstance.handler(makeRequest("/api/khotan/plugs"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  describe("resource and mapping routes", () => {
    let instance: ReturnType<typeof khotan>;

    beforeEach(() => {
      instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "shopify",
            plug: { baseUrl: "https://shopify.com", authType: "bearer" },
            flows: [
              { name: "products-inflow", type: "inflow", resource: "products" },
            ],
          },
          {
            name: "cin7",
            plug: { baseUrl: "https://cin7.com", authType: "bearer" },
          },
        ],
        resources: [
          {
            name: "products",
            mapping: {
              connectField: "sku",
              plugs: {
                shopify: { uniqueIdentifier: "id" },
                cin7: { uniqueIdentifier: "id" },
              },
            },
          },
        ],
      });
    });

    it("GET .../resources lists resources", async () => {
      const res = await instance.handler(makeRequest("/api/khotan/resources"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it("GET .../resources/:id returns resource with flows", async () => {
      await instance.init();
      const res = await instance.handler(
        makeRequest("/api/khotan/resources/resource-1"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("products");
      expect(data.mapping.connectField).toBe("sku");
      expect(data.mapping.plugs).toEqual({
        shopify: { uniqueIdentifier: "id" },
        cin7: { uniqueIdentifier: "id" },
      });
      expect(data.flows).toHaveLength(1);
      expect(data.flows[0].name).toBe("products-inflow");
    });

    it("GET .../resources/:id returns 404 for unknown resource", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/resources/nonexistent"),
      );
      expect(res.status).toBe(404);
    });

    it("GET .../resources/:id/mappings lists mappings for resource", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/resources/resource-1/mappings"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it("GET .../resources/:id/mappings returns paginated search results", async () => {
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123" },
          metadata: { name: "Blue Widget" },
        }),
      );
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-002",
          refs: { shopify: "prod_456" },
          metadata: { name: "Green Widget" },
        }),
      );

      const res = await instance.handler(
        makeRequest(
          "/api/khotan/resources/resource-1/mappings?limit=1&search=green",
        ),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      expect(data.items[0].connectValue).toBe("SKU-002");
      expect(data.page).toMatchObject({
        limit: 1,
        offset: 0,
        hasMore: false,
        total: 1,
      });
    });

    it("POST .../mappings creates a mapping with 201", async () => {
      const body = {
        resourceId: "resource-1",
        connectValue: "SKU-001",
        refs: { shopify: "prod_123" },
        metadata: { name: "Blue Widget" },
      };
      const res = await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", body),
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toMatchObject({
        connectValue: "SKU-001",
        refs: { shopify: "prod_123" },
      });
    });

    it("POST .../mappings returns 200 on upsert of existing mapping", async () => {
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123" },
        }),
      );

      const res = await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { cin7: "P-456" },
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.refs).toEqual({
        shopify: "prod_123",
        cin7: "P-456",
      });
    });

    it("mapping(resource).upsert resolves resource name and lookupByRef finds refs", async () => {
      const saved = await instance.mapping("products").upsert({
        connectValue: "SKU-001",
        refs: { shopify: "prod_123" },
      });

      expect(saved).toMatchObject({
        resourceId: "resource-1",
        connectValue: "SKU-001",
        refs: { shopify: "prod_123" },
      });

      const found = await instance
        .mapping("products")
        .lookupByRef("shopify", "prod_123");
      expect(found?.["id"]).toBe(saved["id"]);
    });

    it("mapping(resource).upsert merges partial refs by default and can replace refs", async () => {
      await instance.mapping("products").upsert({
        connectValue: "SKU-001",
        refs: { shopify: "prod_123" },
      });

      const merged = await instance.mapping("products").upsert({
        connectValue: "SKU-001",
        refs: { cin7: "P-456" },
      });
      expect(merged.refs).toEqual({
        shopify: "prod_123",
        cin7: "P-456",
      });

      const replaced = await instance.mapping("products").upsert({
        connectValue: "SKU-001",
        refs: { cin7: "P-789" },
        mergeRefs: false,
      });
      expect(replaced.refs).toEqual({ cin7: "P-789" });
    });

    it("updateMapping replaces refs by default but can merge refs when requested", async () => {
      const created = await instance.upsertMapping({
        resourceId: "resource-1",
        connectValue: "SKU-001",
        refs: { shopify: "prod_123" },
      });

      const merged = await instance.updateMapping(created["id"] as string, {
        resourceId: "resource-1",
        connectValue: "SKU-001",
        refs: { cin7: "P-456" },
        mergeRefs: true,
      });
      expect(merged.refs).toEqual({
        shopify: "prod_123",
        cin7: "P-456",
      });

      const replaced = await instance.updateMapping(created["id"] as string, {
        resourceId: "resource-1",
        connectValue: "SKU-001",
        refs: { shopify: "prod_999" },
      });
      expect(replaced.refs).toEqual({ shopify: "prod_999" });
    });

    it("flow run contexts expose mapping(resource) helpers", async () => {
      const flowInstance = khotan({
        adapter,
        authorize: false,
        plugs: [
          {
            name: "shopify",
            plug: { baseUrl: "https://shopify.com", authType: "bearer" },
            flows: [
              {
                name: "sync-products",
                type: "inflow",
                resource: "products",
                run: async (ctx) => {
                  await ctx.mapping("products").upsert({
                    connectValue: "SKU-001",
                    refs: { shopify: "prod_123" },
                  });
                  const found = await ctx
                    .mapping("products")
                    .lookupByRef("shopify", "prod_123");

                  return {
                    status: found ? "completed" : "failed",
                    created: found ? 1 : 0,
                    failed: found ? 0 : 1,
                  };
                },
              },
            ],
          },
        ],
        resources: [
          {
            name: "products",
            mapping: {
              connectField: "sku",
              plugs: {
                shopify: { uniqueIdentifier: "id" },
              },
            },
          },
        ],
      });

      const result = await flowInstance.flow("sync-products").start();

      expect(result).toMatchObject({
        status: "completed",
        created: 1,
      });
      await expect(
        flowInstance.mapping("products").lookup("SKU-001"),
      ).resolves.toMatchObject({ refs: { shopify: "prod_123" } });
    });

    it("POST .../mappings rejects refs for undeclared plugs", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { pollinate: "prod_999" },
        }),
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining("Invalid refs"),
      });
    });

    it("GET .../mappings/:id returns a mapping", async () => {
      // Create first
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123" },
        }),
      );

      const res = await instance.handler(
        makeRequest("/api/khotan/mappings/mapping-1"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.connectValue).toBe("SKU-001");
    });

    it("GET .../mappings/:id returns 404 for unknown mapping", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/mappings/nonexistent"),
      );
      expect(res.status).toBe(404);
    });

    it("PUT .../mappings/:id updates a mapping", async () => {
      // Create first
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123" },
        }),
      );

      const res = await instance.handler(
        makeRequest("/api/khotan/mappings/mapping-1", "PUT", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123", cin7: "P-456" },
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("id", "mapping-1");
    });

    it("DELETE .../mappings/:id deletes a mapping", async () => {
      // Create first
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123" },
        }),
      );

      const res = await instance.handler(
        makeRequest("/api/khotan/mappings/mapping-1", "DELETE"),
      );
      expect(res.status).toBe(204);
    });

    it("POST .../mappings/lookup finds mapping by plug ref", async () => {
      // Create first
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123" },
        }),
      );

      const res = await instance.handler(
        makeRequest("/api/khotan/mappings/lookup", "POST", {
          resourceId: "resource-1",
          plugName: "shopify",
          ref: "prod_123",
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.connectValue).toBe("SKU-001");
    });

    it("POST .../mappings/lookup finds mapping by connect value", async () => {
      await instance.handler(
        makeRequest("/api/khotan/mappings", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
          refs: { shopify: "prod_123" },
        }),
      );

      const res = await instance.handler(
        makeRequest("/api/khotan/mappings/lookup", "POST", {
          resourceId: "resource-1",
          connectValue: "SKU-001",
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.refs).toEqual({ shopify: "prod_123" });
    });

    it("canonicalizes composite connect values deterministically", async () => {
      const composite = khotanOpen({
        adapter,
        plugs: [
          {
            name: "cin7",
            plug: { baseUrl: "https://cin7.com", authType: "bearer" },
          },
        ],
        resources: [
          {
            name: "customers",
            mapping: {
              connectField: ["tenantId", "email"],
              plugs: {
                cin7: { uniqueIdentifier: "id" },
              },
            },
          },
        ],
      });

      const created = await composite.upsertMapping({
        resourceId: "resource-1",
        connectValue: ["tenant-a", "alice@example.com"],
        refs: { cin7: "cust_123" },
      });
      expect(created.connectValue).toBe('["tenant-a","alice@example.com"]');

      const found = await composite.lookupMapping({
        resourceId: "resource-1",
        connectValue: ["tenant-a", "alice@example.com"],
      });
      expect(found?.["connectValue"]).toBe('["tenant-a","alice@example.com"]');
    });

    it("POST .../mappings/lookup returns 404 when not found", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/mappings/lookup", "POST", {
          resourceId: "resource-1",
          plugName: "shopify",
          ref: "nonexistent",
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH toggle endpoints", () => {
    let instance: ReturnType<typeof khotan>;

    beforeEach(() => {
      instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
            flows: [{ name: "products", type: "inflow" }],
          },
        ],
      });
    });

    it("PATCH .../plugs/:id toggles plug enabled", async () => {
      await instance.init();
      const res = await instance.handler(
        makeRequest("/api/khotan/plugs/plug-1", "PATCH", { enabled: false }),
      );
      expect(res.status).toBe(200);
      expect(adapter.togglePlugEnabled).toHaveBeenCalledWith("plug-1", false);
    });

    it("PATCH .../plugs/:id returns 404 for unknown plug", async () => {
      await instance.init();
      const res = await instance.handler(
        makeRequest("/api/khotan/plugs/nonexistent", "PATCH", {
          enabled: true,
        }),
      );
      expect(res.status).toBe(404);
    });

    it("PATCH .../flows/:id toggles flow enabled", async () => {
      await instance.init();
      const res = await instance.handler(
        makeRequest("/api/khotan/flows/flow-1", "PATCH", { enabled: false }),
      );
      expect(res.status).toBe(200);
      expect(adapter.toggleFlowEnabled).toHaveBeenCalledWith("flow-1", false);
      const data = await res.json();
      expect(data).toHaveProperty("id", "flow-1");
      expect(data).toHaveProperty("enabled", false);
    });

    it("PATCH .../flows/:id ignores non-boolean enabled", async () => {
      await instance.init();
      const res = await instance.handler(
        makeRequest("/api/khotan/flows/flow-1", "PATCH", { enabled: "yes" }),
      );
      expect(res.status).toBe(200);
      expect(adapter.toggleFlowEnabled).not.toHaveBeenCalled();
    });

    it("PATCH returns 404 for unmatched routes", async () => {
      const res = await instance.handler(
        makeRequest("/api/khotan/unknown", "PATCH", { enabled: true }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("config-driven filtering", () => {
    it("GET /plugs excludes plugs not in config", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
          },
        ],
      });
      await instance.init();

      // Manually insert an orphaned plug into the store via adapter
      await adapter.upsertPlug({
        name: "orphaned",
        baseUrl: "https://orphaned.com",
        authType: "bearer",
      });

      const res = await instance.handler(makeRequest("/api/khotan/plugs"));
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("stripe");
    });

    it("GET /plugs/:id returns 404 for orphaned plug", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
          },
        ],
      });
      await instance.init();

      await adapter.upsertPlug({
        name: "orphaned",
        baseUrl: "https://orphaned.com",
        authType: "bearer",
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/plugs/plug-2"),
      );
      expect(res.status).toBe(404);
    });

    it("GET /flows excludes flows from unregistered plugs", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
            flows: [{ name: "payments", type: "inflow" }],
          },
        ],
      });
      await instance.init();

      // Insert an orphaned plug with a flow
      const { id: orphanPlugId } = await adapter.upsertPlug({
        name: "orphaned",
        baseUrl: "https://orphaned.com",
        authType: "bearer",
      });
      await adapter.upsertFlow({
        plugId: orphanPlugId,
        name: "orphan-flow",
        type: "inflow",
      });

      const res = await instance.handler(makeRequest("/api/khotan/flows"));
      const data = await res.json();
      const names = data.map((flow: { name: string }) => flow.name);
      expect(names).toContain("payments");
      expect(names).not.toContain("orphan-flow");
    });

    it("GET /resources excludes unregistered resources", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [],
        resources: [{ name: "products", mapping: { connectField: "sku" } }],
      });
      await instance.init();

      await adapter.upsertResource({
        name: "orphaned-resource",
        connectField: "id",
      });

      const res = await instance.handler(makeRequest("/api/khotan/resources"));
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("products");
    });

    it("GET /resources/:id returns 404 for orphaned resource", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [],
        resources: [{ name: "products", mapping: { connectField: "sku" } }],
      });
      await instance.init();

      await adapter.upsertResource({
        name: "orphaned-resource",
        connectField: "id",
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/resources/resource-2"),
      );
      expect(res.status).toBe(404);
    });

    it("PATCH /plugs/:id returns 404 for orphaned plug", async () => {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: { baseUrl: "https://api.stripe.com", authType: "bearer" },
          },
        ],
      });
      await instance.init();

      await adapter.upsertPlug({
        name: "orphaned",
        baseUrl: "https://orphaned.com",
        authType: "bearer",
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/plugs/plug-2", "PATCH", { enabled: false }),
      );
      expect(res.status).toBe(404);
      expect(adapter.togglePlugEnabled).not.toHaveBeenCalled();
    });
  });
});

describe("debug route", () => {
  let adapter: KhotanAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  it("returns 404 when KHOTAN_DEBUG is unset", async () => {
    const originalEnv = process.env["KHOTAN_DEBUG"];
    delete process.env["KHOTAN_DEBUG"];
    try {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(async () => ({ ok: true })),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/debug/stripe", "POST", {
          method: "GET",
          path: "/products",
        }),
      );
      expect(res.status).toBe(404);
    } finally {
      if (originalEnv !== undefined) process.env["KHOTAN_DEBUG"] = originalEnv;
    }
  });

  it("proxies a GET request and returns timing + response", async () => {
    const originalEnv = process.env["KHOTAN_DEBUG"];
    process.env["KHOTAN_DEBUG"] = "1";
    try {
      const mockGet = vi.fn(async () => ({ products: [{ id: "p1" }] }));
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: mockGet,
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/debug/stripe", "POST", {
          method: "GET",
          path: "/products",
          params: { limit: "10" },
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe(200);
      expect(data.body).toEqual({ products: [{ id: "p1" }] });
      expect(typeof data.timing).toBe("number");
      expect(data.timing).toBeGreaterThanOrEqual(0);
      expect(mockGet).toHaveBeenCalledWith(
        "/products",
        expect.objectContaining({ params: { limit: "10" } }),
      );
    } finally {
      if (originalEnv !== undefined) {
        process.env["KHOTAN_DEBUG"] = originalEnv;
      } else {
        delete process.env["KHOTAN_DEBUG"];
      }
    }
  });

  it("handles plug errors gracefully", async () => {
    const originalEnv = process.env["KHOTAN_DEBUG"];
    process.env["KHOTAN_DEBUG"] = "1";
    try {
      const error = Object.assign(new Error("Unauthorized"), {
        status: 401,
        body: { message: "Invalid API key" },
      });
      const mockGet = vi.fn(async () => {
        throw error;
      });
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: mockGet,
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/debug/stripe", "POST", {
          method: "GET",
          path: "/charges",
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe(401);
      expect(data.error).toBe("Unauthorized");
      expect(data.body).toEqual({ message: "Invalid API key" });
      expect(typeof data.timing).toBe("number");
    } finally {
      if (originalEnv !== undefined) {
        process.env["KHOTAN_DEBUG"] = originalEnv;
      } else {
        delete process.env["KHOTAN_DEBUG"];
      }
    }
  });

  it("returns 404 for unknown plug name", async () => {
    const originalEnv = process.env["KHOTAN_DEBUG"];
    process.env["KHOTAN_DEBUG"] = "1";
    try {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
          },
        ],
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/debug/nonexistent", "POST", {
          method: "GET",
          path: "/test",
        }),
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Plug not found");
    } finally {
      if (originalEnv !== undefined) {
        process.env["KHOTAN_DEBUG"] = originalEnv;
      } else {
        delete process.env["KHOTAN_DEBUG"];
      }
    }
  });

  it("includes varsConfigured in GET /plugs responses", async () => {
    const instance = khotanOpen({
      adapter,
      plugs: [
        {
          name: "stripe",
          plug: {
            baseUrl: "https://api.stripe.com",
            authType: "bearer",
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            patch: vi.fn(),
            delete: vi.fn(),
          },
        },
      ],
    });

    const res = await instance.handler(makeRequest("/api/khotan/plugs"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]).toMatchObject({
      name: "stripe",
      varsConfigured: false,
    });
  });

  it("seeds default variable values into storage on init", async () => {
    const instance = khotanOpen({
      adapter,
      secret: "test-secret",
      plugs: [
        {
          name: "stripe",
          plug: {
            baseUrl: "https://api.stripe.com",
            authType: "bearer",
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            patch: vi.fn(),
            delete: vi.fn(),
            varFields: [
              {
                key: "region",
                label: "Region",
                type: "text",
                defaultValue: "au",
                required: false,
              },
              {
                key: "apiKey",
                label: "API Key",
                type: "password",
                secret: true,
                defaultValue: "seed-secret",
              },
            ],
          },
        },
      ],
    });

    await instance.init();

    await expect(instance.getVars("stripe")).resolves.toEqual({
      region: "au",
      apiKey: "seed-secret",
    });

    const res = await instance.handler(
      makeRequest("/api/khotan/variables/stripe"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      configured: true,
      values: {
        region: "au",
        apiKey: "••••••••",
      },
    });
  });

  it("merges variable updates so omitted secrets are preserved", async () => {
    const instance = khotanOpen({
      adapter,
      secret: "test-secret",
      plugs: [
        {
          name: "stripe",
          plug: {
            baseUrl: "https://api.stripe.com",
            authType: "bearer",
            get: vi.fn(),
            post: vi.fn(),
            put: vi.fn(),
            patch: vi.fn(),
            delete: vi.fn(),
            varFields: [
              {
                key: "apiKey",
                label: "API Key",
                type: "password",
                secret: true,
              },
              {
                key: "orgId",
                label: "Org ID",
                type: "text",
              },
            ],
          },
        },
      ],
    });

    await instance.init();
    await instance.setVars("stripe", {
      apiKey: "existing-secret",
      orgId: "old-org",
    });

    const saveRes = await instance.handler(
      makeRequest("/api/khotan/variables/stripe", "POST", {
        orgId: "new-org",
      }),
    );
    expect(saveRes.status).toBe(200);

    await expect(instance.getVars("stripe")).resolves.toEqual({
      apiKey: "existing-secret",
      orgId: "new-org",
    });

    const res = await instance.handler(
      makeRequest("/api/khotan/variables/stripe"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.values).toMatchObject({
      apiKey: "••••••••",
      orgId: "new-org",
    });
  });

  it("serializes nested response schemas in debug metadata", async () => {
    const originalEnv = process.env["KHOTAN_DEBUG"];
    process.env["KHOTAN_DEBUG"] = "1";
    try {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
              endpoints: {
                listProducts: {
                  method: "GET",
                  path: "/products",
                  responses: {
                    200: z.object({
                      data: z.object({
                        items: z.array(
                          z.object({
                            id: z.string(),
                            name: z.string(),
                          }),
                        ),
                      }),
                    }),
                  },
                },
              },
            },
          },
        ],
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/debug/stripe"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.endpoints.listProducts.responses["200"]).toEqual({
        data: {
          items: {
            _type: "array",
            items: {
              id: "string",
              name: "string",
            },
          },
        },
      });
    } finally {
      if (originalEnv !== undefined) {
        process.env["KHOTAN_DEBUG"] = originalEnv;
      } else {
        delete process.env["KHOTAN_DEBUG"];
      }
    }
  });

  it("serializes v4-style schema defs in debug metadata", async () => {
    const originalEnv = process.env["KHOTAN_DEBUG"];
    process.env["KHOTAN_DEBUG"] = "1";
    try {
      const v4StyleBodySchema = {
        _def: {
          type: "object",
          shape: {
            partnershipId: { _def: { type: "string" } },
            status: {
              _def: {
                type: "enum",
                entries: { draft: "draft", accepted: "accepted" },
              },
            },
            totalAmount: { _def: { type: "number" } },
            notes: {
              _def: {
                type: "optional",
                innerType: { _def: { type: "string" } },
              },
            },
            lines: {
              _def: {
                type: "array",
                element: {
                  _def: {
                    type: "object",
                    shape: {
                      quantity: { _def: { type: "number" } },
                      description: { _def: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "pollinate",
            plug: {
              baseUrl: "https://api.pollinate.tech",
              authType: "bearer",
              get: vi.fn(),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
              endpoints: {
                createOrder: {
                  method: "POST",
                  path: "/orders",
                  body: v4StyleBodySchema,
                },
              },
            },
          },
        ],
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/debug/pollinate"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.endpoints.createOrder.body).toEqual({
        partnershipId: "string",
        status: '"draft" | "accepted"',
        totalAmount: "number",
        notes: "string?",
        lines: {
          _type: "array",
          items: {
            quantity: "number",
            description: "string",
          },
        },
      });
    } finally {
      if (originalEnv !== undefined) {
        process.env["KHOTAN_DEBUG"] = originalEnv;
      } else {
        delete process.env["KHOTAN_DEBUG"];
      }
    }
  });

  it("includes endpoint metadata when path matches typed endpoint", async () => {
    const originalEnv = process.env["KHOTAN_DEBUG"];
    process.env["KHOTAN_DEBUG"] = "1";
    try {
      const instance = khotanOpen({
        adapter,
        plugs: [
          {
            name: "stripe",
            plug: {
              baseUrl: "https://api.stripe.com",
              authType: "bearer",
              get: vi.fn(async () => []),
              post: vi.fn(),
              put: vi.fn(),
              patch: vi.fn(),
              delete: vi.fn(),
            },
            endpoints: {
              listProducts: { method: "GET", path: "/products" },
              createCharge: { method: "POST", path: "/charges" },
            },
          },
        ],
      });

      const res = await instance.handler(
        makeRequest("/api/khotan/debug/stripe", "POST", {
          method: "GET",
          path: "/products",
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.endpoint).toEqual({
        name: "listProducts",
        method: "GET",
        path: "/products",
      });
    } finally {
      if (originalEnv !== undefined) {
        process.env["KHOTAN_DEBUG"] = originalEnv;
      } else {
        delete process.env["KHOTAN_DEBUG"];
      }
    }
  });
});

describe("authorize hook", () => {
  let adapter: KhotanAdapter;

  function makePlug(name = "stripe") {
    return {
      name,
      plug: {
        baseUrl: "https://api.stripe.com",
        authType: "bearer" as const,
        get: vi.fn(async () => ({ ok: true })),
        post: vi.fn(),
        put: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    };
  }

  beforeEach(() => {
    adapter = createMockAdapter();
  });

  it("rejects management routes with 401 when authorize returns false", async () => {
    const authorize = vi.fn(async () => false);
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(makeRequest("/api/khotan/plugs"));
    expect(res.status).toBe(401);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable 401 body (code + hint) on rejection", async () => {
    const authorize = vi.fn(async () => false);
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(makeRequest("/api/khotan/plugs"));
    const body = (await res.json()) as {
      error: string;
      code?: string;
      hint?: string;
    };
    expect(body.error).toBe("Unauthorized");
    expect(body.code).toBe("authorize_rejected");
    expect(body.hint).toMatch(/KHOTAN_SECRET/);
  });

  it("allows management routes when authorize returns true", async () => {
    const authorize = vi.fn(async () => true);
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(makeRequest("/api/khotan/plugs"));
    expect(res.status).toBe(200);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("blocks credential writes (POST /variables) when unauthorized", async () => {
    const authorize = vi.fn(async () => false);
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(
      makeRequest("/api/khotan/variables/stripe", "POST", { apiKey: "x" }),
    );
    expect(res.status).toBe(401);
  });

  it("treats a thrown authorize as rejection", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("session lookup failed");
    });
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(makeRequest("/api/khotan/plugs"));
    expect(res.status).toBe(401);
  });

  it("exempts inbound webhooks from authorize", async () => {
    const authorize = vi.fn(async () => false);
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(
      makeRequest("/api/khotan/webhook/stripe", "POST", { type: "ping" }),
    );
    // Not 401 — webhook routes carry their own (onVerify) protection.
    expect(res.status).not.toBe(401);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("exempts the cron dispatcher from authorize", async () => {
    const authorize = vi.fn(async () => false);
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(makeRequest("/api/khotan/cron"));
    expect(res.status).not.toBe(401);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("passes the raw Request to authorize (composes with session libs)", async () => {
    let seenHeader: string | null = null;
    const authorize = vi.fn(async (request: Request) => {
      seenHeader = request.headers.get("cookie");
      return seenHeader === "session=valid";
    });
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const req = new Request("http://localhost/api/khotan/plugs", {
      headers: { cookie: "session=valid" },
    });
    const res = await instance.handler(req);
    expect(res.status).toBe(200);
    expect(seenHeader).toBe("session=valid");
  });

  it("default-denies management routes in development when authorize is omitted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = khotan({ adapter, plugs: [makePlug()] });
    const res = await instance.handler(makeRequest("/api/khotan/plugs"));
    expect(res.status).toBe(401);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("No `authorize`"),
    );
    warn.mockRestore();
  });

  it("allows management routes when authorize: false explicitly opts out in development", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const instance = khotan({ adapter, plugs: [makePlug()], authorize: false });
    const res = await instance.handler(makeRequest("/api/khotan/plugs"));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("`authorize: false`"),
    );
    warn.mockRestore();
  });

  it("throws in production when authorize is omitted", () => {
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => khotan({ adapter, plugs: [makePlug()] })).toThrow(
        /`authorize` is required in production/,
      );
    } finally {
      if (previous === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = previous;
    }
  });

  it("throws in production when authorize: false is configured", () => {
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() =>
        khotan({ adapter, plugs: [makePlug()], authorize: false }),
      ).toThrow(/`authorize: false` is not allowed in production/);
    } finally {
      if (previous === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = previous;
    }
  });
});

describe("CLI auth token (dev-only HMAC bypass)", () => {
  const SECRET = "test-khotan-secret-value";
  let adapter: KhotanAdapter;
  let originalNodeEnv: string | undefined;

  function makePlug(name = "stripe") {
    return {
      name,
      plug: {
        baseUrl: "https://api.stripe.com",
        authType: "bearer" as const,
        get: vi.fn(async () => ({ ok: true })),
        post: vi.fn(),
        put: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    };
  }

  async function cliHeader(
    secret = SECRET,
    ts: number = Date.now(),
  ): Promise<string> {
    const sig = await deriveCliToken(secret, String(ts));
    return `KhotanCLI ${ts}.${sig}`;
  }

  function tokenRequest(authorization: string): Request {
    return new Request("http://localhost/api/khotan/plugs", {
      headers: { Authorization: authorization },
    });
  }

  beforeEach(() => {
    adapter = createMockAdapter();
    originalNodeEnv = process.env["NODE_ENV"];
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
  });

  it("allows a valid CLI token even when authorize rejects (and skips authorize)", async () => {
    process.env["NODE_ENV"] = "development";
    const authorize = vi.fn(async () => false);
    const instance = khotan({
      adapter,
      plugs: [makePlug()],
      authorize,
      secret: SECRET,
    });

    const res = await instance.handler(tokenRequest(await cliHeader()));
    expect(res.status).toBe(200);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects the CLI token in production (bypass never applies on deploy)", async () => {
    process.env["NODE_ENV"] = "production";
    const authorize = vi.fn(async () => false);
    const instance = khotan({
      adapter,
      plugs: [makePlug()],
      authorize,
      secret: SECRET,
    });

    const res = await instance.handler(tokenRequest(await cliHeader()));
    expect(res.status).toBe(401);
    // Falls through to the real authorize hook in production.
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale CLI token (outside the freshness window)", async () => {
    process.env["NODE_ENV"] = "development";
    const authorize = vi.fn(async () => false);
    const instance = khotan({
      adapter,
      plugs: [makePlug()],
      authorize,
      secret: SECRET,
    });

    const stale = Date.now() - 120_000;
    const res = await instance.handler(
      tokenRequest(await cliHeader(SECRET, stale)),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a tampered CLI token signature", async () => {
    process.env["NODE_ENV"] = "development";
    const authorize = vi.fn(async () => false);
    const instance = khotan({
      adapter,
      plugs: [makePlug()],
      authorize,
      secret: SECRET,
    });

    const ts = Date.now();
    const res = await instance.handler(
      tokenRequest(`KhotanCLI ${ts}.deadbeefdeadbeef`),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    process.env["NODE_ENV"] = "development";
    const authorize = vi.fn(async () => false);
    const instance = khotan({
      adapter,
      plugs: [makePlug()],
      authorize,
      secret: SECRET,
    });

    const res = await instance.handler(
      tokenRequest(await cliHeader("a-different-secret")),
    );
    expect(res.status).toBe(401);
  });

  it("ignores the CLI token when no secret is configured", async () => {
    process.env["NODE_ENV"] = "development";
    const authorize = vi.fn(async () => false);
    const instance = khotan({ adapter, plugs: [makePlug()], authorize });

    const res = await instance.handler(tokenRequest(await cliHeader()));
    expect(res.status).toBe(401);
  });
});

describe("toNextJsHandler", () => {
  it("wraps handler into GET/POST/PUT/PATCH/DELETE exports", () => {
    const mockHandler = vi.fn(async () => Response.json({ ok: true }));
    const handlers = toNextJsHandler(mockHandler);

    expect(handlers).toHaveProperty("GET");
    expect(handlers).toHaveProperty("POST");
    expect(handlers).toHaveProperty("PUT");
    expect(handlers).toHaveProperty("PATCH");
    expect(handlers).toHaveProperty("DELETE");
  });

  it("delegates GET to the factory handler", async () => {
    const mockHandler = vi.fn(async () => Response.json({ ok: true }));
    const handlers = toNextJsHandler(mockHandler);

    const req = new Request("http://localhost/api/khotan/plugs");
    const res = await handlers.GET(req);
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalledWith(req);
  });

  it("delegates POST to the factory handler", async () => {
    const mockHandler = vi.fn(async () =>
      Response.json({ created: true }, { status: 201 }),
    );
    const handlers = toNextJsHandler(mockHandler);

    const req = new Request("http://localhost/api/khotan/flows/1/runs", {
      method: "POST",
    });
    const res = await handlers.POST(req);
    expect(res.status).toBe(201);
    expect(mockHandler).toHaveBeenCalledWith(req);
  });

  it("delegates PATCH to the factory handler", async () => {
    const mockHandler = vi.fn(async () => Response.json({ updated: true }));
    const handlers = toNextJsHandler(mockHandler);

    const req = new Request("http://localhost/api/khotan/plugs/1", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await handlers.PATCH(req);
    expect(res.status).toBe(200);
    expect(mockHandler).toHaveBeenCalledWith(req);
  });
});

describe("factory scaffold builders", () => {
  it("builds flow registrations with normalized flow types", () => {
    const inflowWorkflow = vi.fn(async (ctx: { flow: { type: "inflow" } }) => {
      expect(ctx.flow.type).toBe("inflow");
      return { extracted: 1 };
    });
    const outflowWorkflow = vi.fn(
      async (ctx: { body?: { dryRun: boolean } }) => {
        if (ctx.body?.dryRun) return { skipped: 1 };
        return { created: 1 };
      },
    );
    const relayWorkflow = vi.fn(async () => ({ transformed: 1 }));

    const inflowRegistration = inflow({
      name: "products-in",
      resource: "products",
      schedule: "0 * * * *",
      workflow: inflowWorkflow,
    });
    const outflowRegistration = outflow<{ dryRun: boolean }>({
      name: "products-out",
      resource: "products",
      variants: { full: {} },
      workflow: outflowWorkflow,
    });
    const relayRegistration = relay({
      name: "products-relay",
      to: "hubspot",
      workflow: relayWorkflow,
    });

    expect(inflowRegistration).toMatchObject({
      name: "products-in",
      type: "inflow",
      resource: "products",
      schedule: "0 * * * *",
    });
    expect(outflowRegistration).toMatchObject({
      name: "products-out",
      type: "outflow",
      resource: "products",
      variants: { full: {} },
    });
    expect(relayRegistration).toMatchObject({
      name: "products-relay",
      type: "relay",
      to: "hubspot",
    });
    expect(inflowRegistration.workflow).toBe(inflowWorkflow);
    expect(outflowRegistration.workflow).toBe(outflowWorkflow);
    expect(relayRegistration.workflow).toBe(relayWorkflow);
  });

  it("builds webhook registrations from catchEvent and wire", async () => {
    const catchRegistration = catchEvent<{ id: string }>({
      name: "orders",
      events: ["order.created"],
      async workflow(ctx) {
        expect(ctx.event.id).toBe("evt_1");
      },
    });
    const wireRegistration = wire({
      events: ["order.created"],
      async onSubscribe() {
        return { remoteId: "remote_1" };
      },
      async onUnsubscribe() {},
    });

    await catchRegistration.workflow({
      event: { id: "evt_1" },
      eventType: "order.created",
      headers: {},
      khotanRunId: "run_1",
      khotanInstanceId: "instance_1",
    });

    expect(catchRegistration).toMatchObject({
      type: "catch",
      name: "orders",
      events: ["order.created"],
    });
    expect(await wireRegistration.onSubscribe({} as never)).toEqual({
      remoteId: "remote_1",
    });
  });
});
