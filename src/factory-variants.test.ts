import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  khotan,
  slackNotifier,
  __setWorkflowStartForTests,
  type KhotanAdapter,
} from "./factory.js";
import { normalizeFlowVariants, DEFAULT_VARIANT } from "./factory/helpers.js";
import type { FlowRegistration } from "./factory/types.js";

// ---------------------------------------------------------------------------
// Compact in-memory adapter — only the methods exercised by variant flows.
// Exposes its flow/run stores so tests can backdate baselines for the cron
// dispatcher.
// ---------------------------------------------------------------------------

interface MockFlow {
  id: string;
  plugId: string;
  name: string;
  type: string;
  plugName: string;
  schedule: string | null;
  resourceId: string | null;
  enabled: boolean;
  createdAt: Date;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
}

interface MockRun {
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

function createMockAdapter() {
  const plugStore = new Map<string, { id: string; name: string }>();
  const flowStore = new Map<string, MockFlow>();
  const runStore = new Map<string, MockRun>();
  let plugCounter = 0;
  let flowCounter = 0;
  let runCounter = 0;

  const adapter: KhotanAdapter = {
    async upsertPlug(plug) {
      const existing = [...plugStore.values()].find(
        (p) => p.name === plug.name,
      );
      if (existing) return { id: existing.id };
      const id = `plug-${++plugCounter}`;
      plugStore.set(id, { id, name: plug.name });
      return { id };
    },
    async upsertFlow(flow) {
      const existing = [...flowStore.values()].find(
        (f) => f.plugId === flow.plugId && f.name === flow.name,
      );
      const plug = plugStore.get(flow.plugId);
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
        plugName: plug?.name ?? "",
        schedule: flow.schedule ?? null,
        resourceId: null,
        enabled: true,
        createdAt: new Date(),
        lastRunAt: null,
        lastRunStatus: null,
      });
      return { id };
    },
    async getFlow(flowId) {
      return flowStore.get(flowId) ?? null;
    },
    async listFlows() {
      return [...flowStore.values()];
    },
    async listRuns(flowId) {
      return [...runStore.values()]
        .filter((r) => r.flowId === flowId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    },
    async getRun(runId) {
      return runStore.get(runId) ?? null;
    },
    async insertRun(run) {
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
    },
    async updateRun(runId, updates) {
      const run = runStore.get(runId);
      if (run) Object.assign(run, updates);
    },
    async updateFlowLastRun(flowId, updates) {
      const flow = flowStore.get(flowId);
      if (flow) {
        flow.lastRunAt = updates.lastRunAt;
        flow.lastRunStatus = updates.lastRunStatus;
      }
    },
    async updateFlowResourceId() {},
    // Unused-by-these-tests stubs:
    async upsertResource() {
      return { id: "res-1" };
    },
    async upsertCache() {
      return { id: "cache-1" };
    },
    async listPlugs() {
      return [...plugStore.values()];
    },
  } as unknown as KhotanAdapter;

  return { adapter, flowStore, runStore };
}

function makePlug(flows: FlowRegistration[]) {
  return {
    name: "acme",
    plug: {
      baseUrl: "https://api.acme.test",
      authType: "bearer",
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    flows,
  };
}

// ---------------------------------------------------------------------------
// normalizeFlowVariants (task 8.1)
// ---------------------------------------------------------------------------

describe("normalizeFlowVariants", () => {
  it("synthesizes a default variant carrying the top-level schedule", () => {
    const variants = normalizeFlowVariants({
      name: "f",
      type: "inflow",
      schedule: "0 * * * *",
    });
    expect(variants).toEqual({ [DEFAULT_VARIANT]: { schedule: "0 * * * *" } });
  });

  it("synthesizes an empty default variant when no schedule", () => {
    const variants = normalizeFlowVariants({ name: "f", type: "inflow" });
    expect(variants).toEqual({ [DEFAULT_VARIANT]: {} });
  });

  it("returns declared variants as-is", () => {
    const declared = {
      healthcheck: { schedule: "0 6 * * *" },
      full: { schedule: "0 2 * * 0" },
    };
    const variants = normalizeFlowVariants({
      name: "f",
      type: "inflow",
      variants: declared,
    });
    expect(variants).toEqual(declared);
    expect(DEFAULT_VARIANT in variants).toBe(false);
  });

  it("throws when a flow declares both schedule and variants", () => {
    expect(() =>
      normalizeFlowVariants({
        name: "f",
        type: "inflow",
        schedule: "0 * * * *",
        variants: { delta: {} },
      }),
    ).toThrow(/both a top-level "schedule" and "variants"/);
  });

  it("throws on an empty variant name", () => {
    expect(() =>
      normalizeFlowVariants({
        name: "f",
        type: "inflow",
        variants: { "": {} },
      }),
    ).toThrow(/empty name/);
  });
});

// ---------------------------------------------------------------------------
// Config-time validation via khotan() (task 8.1)
// ---------------------------------------------------------------------------

describe("khotan config-time variant validation", () => {
  it("throws when a flow declares both schedule and variants", () => {
    const { adapter } = createMockAdapter();
    expect(() =>
      khotan({
        adapter,
        authorize: false,
        plugs: [
          makePlug([
            {
              name: "items-inflow",
              type: "inflow",
              schedule: "0 * * * *",
              variants: { delta: {} },
              run: vi.fn(),
            },
          ]),
        ],
      }),
    ).toThrow(/both a top-level "schedule" and "variants"/);
  });
});

// ---------------------------------------------------------------------------
// Trigger variant resolution (task 8.2)
// ---------------------------------------------------------------------------

describe("trigger variant resolution", () => {
  it("defaults to the default variant when none requested", async () => {
    const { adapter, runStore } = createMockAdapter();
    const run = vi.fn(async () => ({ extracted: 1 }));
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [makePlug([{ name: "items-inflow", type: "inflow", run }])],
    });
    const result = await instance.flow("items-inflow").start();
    expect(result["variant"]).toBe("default");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "default" }),
    );
    const stored = [...runStore.values()][0];
    expect(stored?.variant).toBe("default");
    expect(stored?.source).toBe("manual");
    instance.dispose();
  });

  it("uses an explicitly requested variant", async () => {
    const { adapter, runStore } = createMockAdapter();
    const run = vi.fn(async () => ({}));
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [makePlug([{ name: "items-inflow", type: "inflow", run }])],
    });
    const result = await instance
      .flow("items-inflow")
      .start({ variant: "delta" });
    expect(result["variant"]).toBe("delta");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "delta" }),
    );
    expect([...runStore.values()][0]?.variant).toBe("delta");
    instance.dispose();
  });

  it("errors listing variants when none is requested and no default exists", async () => {
    const { adapter } = createMockAdapter();
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            variants: { delta: {}, full: {} },
            run: vi.fn(),
          },
        ]),
      ],
    });
    await expect(instance.flow("items-inflow").start()).rejects.toThrow(
      /requires a variant. Available: delta, full/,
    );
    instance.dispose();
  });

  it("maps the deprecated runType alias to variant", async () => {
    const { adapter, runStore } = createMockAdapter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(async () => ({}));
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [makePlug([{ name: "items-inflow", type: "inflow", run }])],
    });
    const result = await instance
      .flow("items-inflow")
      .start({ runType: "delta" });
    expect(result["variant"]).toBe("delta");
    expect([...runStore.values()][0]?.variant).toBe("delta");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"runType" is deprecated'),
    );
    warn.mockRestore();
    instance.dispose();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle hooks (task 8.4)
// ---------------------------------------------------------------------------

describe("variant lifecycle hooks", () => {
  it("fires factory-level onFlowRunComplete without requiring a variant hook", async () => {
    const { adapter } = createMockAdapter();
    const onFlowRunComplete = vi.fn();
    const instance = khotan({
      adapter,
      authorize: false,
      onFlowRunComplete,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            run: vi.fn(async () => ({ extracted: 2 })),
          },
        ]),
      ],
    });

    await instance.flow("items-inflow").start();

    expect(onFlowRunComplete).toHaveBeenCalledTimes(1);
    const [ctx, summary] = onFlowRunComplete.mock.calls[0]!;
    expect(ctx.flow.name).toBe("items-inflow");
    expect(summary).toMatchObject({
      status: "completed",
      extracted: 2,
      source: "manual",
    });
    instance.dispose();
  });

  it("fires onComplete on success with a run summary", async () => {
    const { adapter } = createMockAdapter();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            variants: { default: { onComplete, onError } },
            run: vi.fn(async () => ({ extracted: 5, created: 5 })),
          },
        ]),
      ],
    });
    await instance.flow("items-inflow").start();
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    const [ctx, summary] = onComplete.mock.calls[0]!;
    expect(ctx.flow.name).toBe("items-inflow");
    expect(ctx.variant).toBe("default");
    expect(summary).toMatchObject({
      status: "completed",
      variant: "default",
      source: "manual",
      extracted: 5,
      created: 5,
    });
    instance.dispose();
  });

  it("fires onError on failure", async () => {
    const { adapter } = createMockAdapter();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const onFlowRunFailed = vi.fn();
    const instance = khotan({
      adapter,
      authorize: false,
      onFlowRunFailed,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            variants: { default: { onComplete, onError } },
            run: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        ]),
      ],
    });
    await instance
      .flow("items-inflow")
      .start()
      .catch(() => {});
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const [, summary] = onError.mock.calls[0]!;
    expect(summary).toMatchObject({ status: "failed", error: "boom" });
    expect(onFlowRunFailed).toHaveBeenCalledTimes(1);
    expect(onFlowRunFailed.mock.calls[0]![1]).toMatchObject({
      status: "failed",
      error: "boom",
    });
    instance.dispose();
  });

  it("fires onComplete for the durable workflow path", async () => {
    const { adapter } = createMockAdapter();
    const onComplete = vi.fn();
    const returnValue = Promise.resolve({ extracted: 3, updated: 3 });
    const startWorkflow = vi.fn(async () => ({
      runId: "wf-run-1",
      returnValue,
    }));
    __setWorkflowStartForTests(startWorkflow);

    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            variants: { delta: { onComplete } },
            workflow: vi.fn(async () => undefined),
          },
        ]),
      ],
    });

    await instance.flow("items-inflow").start({ variant: "delta" });
    // Let the fire-and-forget reconciliation settle.
    await returnValue;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const [ctx, summary] = onComplete.mock.calls[0]!;
    expect(ctx.variant).toBe("delta");
    expect(summary).toMatchObject({
      status: "completed",
      variant: "delta",
      extracted: 3,
      updated: 3,
    });
    __setWorkflowStartForTests(null);
    instance.dispose();
  });

  it("isolates a throwing hook (run status unchanged)", async () => {
    const { adapter, runStore } = createMockAdapter();
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            variants: {
              default: {
                onComplete: () => {
                  throw new Error("hook exploded");
                },
              },
            },
            run: vi.fn(async () => ({ extracted: 1 })),
          },
        ]),
      ],
    });
    const result = await instance.flow("items-inflow").start();
    expect(result["status"]).toBe("completed");
    expect([...runStore.values()][0]?.status).toBe("completed");
    instance.dispose();
  });
});

// ---------------------------------------------------------------------------
// Stuck-run reconciliation
// ---------------------------------------------------------------------------

describe("stuck-run reconciliation", () => {
  it("marks stale running flow runs failed and emits the factory failure hook", async () => {
    const { adapter, runStore } = createMockAdapter();
    const onFlowRunFailed = vi.fn();
    const instance = khotan({
      adapter,
      authorize: false,
      onFlowRunFailed,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            run: vi.fn(async () => ({})),
          },
        ]),
      ],
    });

    await instance.init();
    const { id } = await adapter.insertRun({
      flowId: "flow-1",
      variant: "default",
      source: "manual",
      status: "running",
    });
    runStore.get(id)!.startedAt = new Date(Date.now() - 60 * 60_000);

    const result = await instance.flow("items-inflow").reconcileStuck({
      olderThanMs: 10 * 60_000,
      error: "stale worker",
    });

    expect(result).toMatchObject({
      checked: 1,
      reconciled: 1,
      skipped: 0,
    });
    // No workflow run id to ask the engine about, so the outcome is genuinely
    // unknown and must not be asserted as `failed`.
    expect(runStore.get(id)).toMatchObject({
      status: "abandoned",
      error: "stale worker",
      failed: 0,
    });
    expect(onFlowRunFailed).toHaveBeenCalledTimes(1);
    expect(onFlowRunFailed.mock.calls[0]![1]).toMatchObject({
      id,
      status: "abandoned",
      error: "stale worker",
    });
    instance.dispose();
  });

  it("supports dry-run reconciliation through the flow route", async () => {
    const { adapter, runStore } = createMockAdapter();
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            run: vi.fn(async () => ({})),
          },
        ]),
      ],
    });

    await instance.init();
    const { id } = await adapter.insertRun({
      flowId: "flow-1",
      variant: "default",
      source: "manual",
      status: "pending",
    });
    runStore.get(id)!.startedAt = new Date(Date.now() - 60 * 60_000);

    const res = await instance.handler(
      new Request(
        "http://localhost/api/khotan/flows/flow-1/runs/reconcile-stuck",
        {
          method: "POST",
          body: JSON.stringify({ olderThanMs: 10 * 60_000, dryRun: true }),
        },
      ),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      dryRun: true,
      checked: 1,
      reconciled: 0,
      items: [{ id, dryRun: true, reconciled: false }],
    });
    expect(runStore.get(id)?.status).toBe("pending");
    instance.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cron dispatcher per-variant scheduling (task 8.3)
// ---------------------------------------------------------------------------

describe("cron dispatcher per-variant scheduling", () => {
  it("fires scheduled variants and never auto-fires manual-only variants", async () => {
    const { adapter, flowStore } = createMockAdapter();
    const run = vi.fn(async () => ({}));
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            variants: {
              tick: { schedule: "* * * * *" }, // every minute
              backfill: {}, // manual-only
            },
            run,
          },
        ]),
      ],
    });
    await instance.init();
    // Backdate the baseline so the every-minute variant is overdue.
    for (const flow of flowStore.values()) {
      flow.lastRunAt = new Date(Date.now() - 60 * 60 * 1000);
    }

    const res = await instance.handler(
      new Request("http://localhost/api/khotan/cron"),
    );
    const body = (await res.json()) as {
      triggered: Array<Record<string, unknown>>;
      evaluated: number;
    };

    const triggeredVariants = body.triggered.map((t) => t["variant"]);
    expect(triggeredVariants).toContain("tick");
    expect(triggeredVariants).not.toContain("backfill");
    // Only the scheduled variant is evaluated; manual-only is skipped entirely.
    expect(body.evaluated).toBe(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "tick" }),
    );
    instance.dispose();
  });
});

// ---------------------------------------------------------------------------
// API visibility for variant-backed schedules
// ---------------------------------------------------------------------------

describe("flow schedule visibility", () => {
  it("exposes a default variant schedule as the flow's effective schedule", async () => {
    const { adapter, flowStore } = createMockAdapter();
    const instance = khotan({
      adapter,
      authorize: false,
      plugs: [
        makePlug([
          {
            name: "items-inflow",
            type: "inflow",
            variants: {
              default: { schedule: "5 * * * *" },
              backfill: {},
            },
          },
        ]),
      ],
    });

    await instance.init();
    const persistedFlow = [...flowStore.values()][0]!;
    expect(persistedFlow.schedule).toBeNull();

    const res = await instance.handler(
      new Request("http://localhost/api/khotan/flows"),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      name: "items-inflow",
      schedule: "5 * * * *",
      effectiveSchedule: "5 * * * *",
      variants: {
        default: { schedule: "5 * * * *" },
        backfill: {},
      },
    });
    instance.dispose();
  });
});

// ---------------------------------------------------------------------------
// slackNotifier (task 8.4)
// ---------------------------------------------------------------------------

describe("slackNotifier", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs a message describing the run to the webhook URL", async () => {
    const hook = slackNotifier("https://hooks.slack.test/abc");
    await hook(
      {
        flow: {
          id: "f1",
          name: "items-inflow",
          plugName: "acme",
          type: "inflow",
        },
        variant: "delta",
      },
      {
        id: "run-1",
        status: "failed",
        variant: "delta",
        source: "scheduled",
        durationMs: 1234,
        extracted: 0,
        transformed: 0,
        created: 0,
        updated: 0,
        deleted: 0,
        failed: 2,
        skipped: 0,
        error: "kaboom",
      },
    );

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.test/abc");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      flow: "items-inflow",
      plug: "acme",
      variant: "delta",
      status: "failed",
      failed: 2,
      error: "kaboom",
    });
    expect(String(payload["text"])).toContain("items-inflow");
    expect(String(payload["text"])).toContain("delta");
  });
});
