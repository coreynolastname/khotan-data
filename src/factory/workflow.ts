import { khotanRuntimeRegistry } from "./types.js";
import type {
  KhotanPersistedRunUpdateInput,
  KhotanRunUpdate,
  KhotanWorkflowContextRef,
  KhotanWorkflowRuntimeHelpers,
} from "./types.js";

// ---------------------------------------------------------------------------
// Workflow integration — dynamic import of workflow/api
// ---------------------------------------------------------------------------

export type WorkflowStartFn = (
  workflowFn: (...args: never[]) => unknown,
  args: unknown[],
) => Promise<unknown>;

export interface WorkflowRunHandle {
  runId?: string;
  status?: Promise<string>;
  returnValue?: Promise<unknown>;
  cancel?: () => Promise<void>;
  getReadable?: (options?: {
    startIndex?: number;
    namespace?: string;
  }) => ReadableStream;
}

export type WorkflowGetRunFn = (runId: string) => WorkflowRunHandle;
export type WorkflowGetWritableFn = <T = unknown>(options?: {
  namespace?: string;
}) => WritableStream<T>;

export interface WorkflowRuntimeConfig {
  start?: WorkflowStartFn | null;
  getRun?: WorkflowGetRunFn | null;
  getWritable?: WorkflowGetWritableFn | null;
}

type SendUpdateValue = KhotanRunUpdate | string;

export interface SendUpdateOptions {
  namespace?: string;
  ctx?: KhotanWorkflowContextRef;
  runId?: string;
  khotanInstanceId?: string;
}

const COUNTER_KEYS = [
  "progress",
  "extracted",
  "transformed",
  "created",
  "updated",
  "deleted",
  "failed",
  "skipped",
] as const;

let _workflowStart: WorkflowStartFn | null = null;
let _workflowGetRun: WorkflowGetRunFn | null = null;
let _workflowGetWritable: WorkflowGetWritableFn | null = null;

export function configureWorkflowRuntime(runtime: WorkflowRuntimeConfig): void {
  if ("start" in runtime) {
    _workflowStart = runtime.start ?? null;
  }
  if ("getRun" in runtime) {
    _workflowGetRun = runtime.getRun ?? null;
  }
  if ("getWritable" in runtime) {
    _workflowGetWritable = runtime.getWritable ?? null;
  }
}

export function __setWorkflowStartForTests(
  start: WorkflowStartFn | null,
): void {
  configureWorkflowRuntime({ start });
}

export function __setWorkflowGetRunForTests(
  getRun: WorkflowGetRunFn | null,
): void {
  configureWorkflowRuntime({ getRun });
}

export function __setWorkflowGetWritableForTests(
  getWritable: WorkflowGetWritableFn | null,
): void {
  configureWorkflowRuntime({ getWritable });
}

export async function importWorkflowStart(): Promise<WorkflowStartFn> {
  if (_workflowStart) return _workflowStart;
  try {
    const mod = (await import("workflow/api")) as {
      start: WorkflowStartFn;
    };
    _workflowStart = mod.start;
    return _workflowStart;
  } catch (cause) {
    throw new Error(
      "Failed to import workflow/api. Install Vercel Workflow: npm install workflow",
      { cause },
    );
  }
}

export async function importWorkflowGetRun(): Promise<WorkflowGetRunFn> {
  if (_workflowGetRun) return _workflowGetRun;
  try {
    const mod = (await import("workflow/api")) as {
      getRun: WorkflowGetRunFn;
    };
    _workflowGetRun = mod.getRun;
    return _workflowGetRun;
  } catch (cause) {
    throw new Error(
      "Failed to import workflow/api. Install Vercel Workflow: npm install workflow",
      { cause },
    );
  }
}

async function importWorkflowGetWritable(): Promise<WorkflowGetWritableFn> {
  if (_workflowGetWritable) return _workflowGetWritable;
  try {
    const mod = (await import("workflow")) as {
      getWritable: WorkflowGetWritableFn;
    };
    _workflowGetWritable = mod.getWritable;
    return _workflowGetWritable;
  } catch (cause) {
    throw new Error(
      "Failed to import workflow. Install Vercel Workflow: npm install workflow",
      { cause },
    );
  }
}

function isWorkflowRunContext(
  value: unknown,
): value is KhotanWorkflowContextRef & { khotanRunId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)["khotanInstanceId"] ===
      "string" &&
    typeof (value as Record<string, unknown>)["khotanRunId"] === "string"
  );
}

function getRuntimeHelpers(
  ctx: KhotanWorkflowContextRef,
): KhotanWorkflowRuntimeHelpers {
  const helpers = khotanRuntimeRegistry.get(ctx.khotanInstanceId);
  if (helpers) return helpers;
  if (khotanRuntimeRegistry.size === 1) {
    return khotanRuntimeRegistry.values().next().value!;
  }
  throw new Error(
    `Khotan runtime helpers for instance "${ctx.khotanInstanceId}" are not registered ` +
      `(${String(khotanRuntimeRegistry.size)} instance(s) registered, none matched)`,
  );
}

function normalizeRunUpdate(update: SendUpdateValue): {
  counters: Record<string, number> | null;
  metadata: Record<string, unknown> | null;
  payload: KhotanRunUpdate & { type: NonNullable<KhotanRunUpdate["type"]> };
} {
  const payload =
    typeof update === "string"
      ? { type: "log" as const, message: update }
      : { ...update, type: update.type ?? ("progress" as const) };

  const counters: Record<string, number> = {};
  for (const key of COUNTER_KEYS) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      counters[key] = value;
    }
  }

  return {
    counters: Object.keys(counters).length > 0 ? counters : null,
    metadata: typeof update === "string" ? null : (update.metadata ?? null),
    payload,
  };
}

async function persistRunUpdate(
  ctx: KhotanWorkflowContextRef | undefined,
  update: KhotanPersistedRunUpdateInput,
): Promise<void> {
  if (!ctx?.khotanRunId) return;
  const helpers = getRuntimeHelpers(ctx);
  await helpers.appendRunUpdate(update);
}

export function sendUpdate(
  update: SendUpdateValue,
  options?: SendUpdateOptions,
): Promise<void>;
export function sendUpdate(
  ctx: KhotanWorkflowContextRef & { khotanRunId: string },
  update: SendUpdateValue,
  options?: Omit<SendUpdateOptions, "ctx" | "runId" | "khotanInstanceId">,
): Promise<void>;
export async function sendUpdate(
  first: SendUpdateValue | (KhotanWorkflowContextRef & { khotanRunId: string }),
  second?: SendUpdateValue | SendUpdateOptions,
  third: Omit<SendUpdateOptions, "ctx" | "runId" | "khotanInstanceId"> = {},
): Promise<void> {
  const calledWithContext = isWorkflowRunContext(first);
  const update = (calledWithContext ? second : first) as SendUpdateValue;
  const options: SendUpdateOptions = calledWithContext
    ? third
    : ((second as SendUpdateOptions | undefined) ?? {});
  const context = calledWithContext
    ? first
    : (options.ctx ??
      (options.runId
        ? {
            khotanInstanceId: options.khotanInstanceId ?? "",
            khotanRunId: options.runId,
          }
        : undefined));

  const getWritable = await importWorkflowGetWritable();
  const streamOptions: { namespace?: string } = {};
  if (options.namespace) streamOptions.namespace = options.namespace;
  const writable = getWritable<string>(streamOptions);
  const writer = writable.getWriter();
  const timestamp = new Date();
  const { counters, metadata, payload } = normalizeRunUpdate(update);

  try {
    await writer.write(
      `${JSON.stringify({ ...payload, timestamp: timestamp.toISOString() })}\n`,
    );
  } finally {
    writer.releaseLock();
  }

  await persistRunUpdate(context, {
    runId: context?.khotanRunId ?? "",
    timestamp,
    namespace: options.namespace ?? null,
    type: payload.type,
    message: payload.message,
    metadata,
    counters,
  });
}

export function getWorkflowRunId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  if ("runId" in result) return String(result.runId);
  if ("id" in result) return String(result.id);
  return null;
}

export function getWorkflowReturnValue(
  result: unknown,
): Promise<unknown> | null {
  if (!result || typeof result !== "object" || !("returnValue" in result)) {
    return null;
  }
  const returnValue = result.returnValue;
  return returnValue &&
    typeof (returnValue as Promise<unknown>).then === "function"
    ? (returnValue as Promise<unknown>)
    : null;
}

export function getErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "cause" in error &&
    (error as { cause?: unknown }).cause instanceof Error
  ) {
    return (error as { cause: Error }).cause.message;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

export function isWorkflowCancelledError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : "";
  const status = typeof record["status"] === "string" ? record["status"] : "";
  const message =
    typeof record["message"] === "string" ? record["message"] : "";
  return (
    name === "WorkflowRunCancelledError" ||
    status === "cancelled" ||
    message.toLowerCase().includes("cancelled")
  );
}
