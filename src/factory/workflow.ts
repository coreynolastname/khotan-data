import { khotanRuntimeRegistry } from "./types.js";
import { kd } from "./debug.js";
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

export const WORKFLOW_INVALID_FUNCTION_CODE = "start-invalid-workflow-function";
export const KHOTAN_INVALID_WORKFLOW_FUNCTION_CODE =
  "khotan_invalid_workflow_function";

export interface WorkflowRuntimeConfig {
  start?: WorkflowStartFn | null;
  getRun?: WorkflowGetRunFn | null;
  getWritable?: WorkflowGetWritableFn | null;
}

export interface WorkflowStartGuidanceContext {
  kind: "flow" | "webhook";
  name: string;
  plugName?: string | null;
  variant?: string | null;
  routePath?: string;
}

export class KhotanWorkflowStartError extends Error {
  readonly code = KHOTAN_INVALID_WORKFLOW_FUNCTION_CODE;

  constructor(message: string) {
    super(message);
    this.name = "KhotanWorkflowStartError";
  }
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

export async function startWorkflowWithGuidance(
  startWorkflow: WorkflowStartFn,
  workflowFn: Parameters<WorkflowStartFn>[0],
  args: Parameters<WorkflowStartFn>[1],
  context: WorkflowStartGuidanceContext,
): Promise<unknown> {
  try {
    return await startWorkflow(workflowFn, args);
  } catch (error) {
    if (isInvalidWorkflowFunctionError(error)) {
      throw new KhotanWorkflowStartError(
        buildInvalidWorkflowFunctionMessage(context),
      );
    }
    throw error;
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
  // Without a run context there is nothing to attach the update to. This used
  // to return silently, which made `sendUpdate(update)` — the natural call
  // shape — a no-op that looked like it worked. Say so instead.
  if (!ctx?.khotanRunId) {
    kd(
      "flow",
      "sendUpdate called without a run context; the update was streamed but " +
        "not persisted to khotan_run_updates. Pass the workflow ctx as the " +
        "first argument, or set options.runId, to persist it.",
    );
    return;
  }

  // A throw here escapes into user flow code, where wrappers routinely swallow
  // it. Persisting an update is best-effort, so degrade loudly but don't fail
  // the step.
  try {
    const helpers = getRuntimeHelpers(ctx);
    await helpers.appendRunUpdate(update);
  } catch (error) {
    kd("flow", "Failed to persist run update", error);
  }
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

  const timestamp = new Date();
  const { counters, metadata, payload } = normalizeRunUpdate(update);

  try {
    const getWritable = await importWorkflowGetWritable();
    const streamOptions: { namespace?: string } = {};
    if (options.namespace) streamOptions.namespace = options.namespace;
    const writable = getWritable<string>(streamOptions);
    const writer = writable.getWriter();

    try {
      await writer.write(
        `${JSON.stringify({ ...payload, timestamp: timestamp.toISOString() })}\n`,
      );
    } finally {
      writer.releaseLock();
    }
  } catch {
    // Progress updates are best-effort. Missing or unavailable Workflow streams
    // must not fail durable sync steps.
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

export function getKhotanErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" && code.startsWith("khotan_") ? code : null;
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

export function isInvalidWorkflowFunctionError(error: unknown): boolean {
  return hasInvalidWorkflowFunctionCode(error, 0);
}

function hasInvalidWorkflowFunctionCode(
  value: unknown,
  depth: number,
): boolean {
  if (!value || typeof value !== "object" || depth > 5) return false;
  const record = value as Record<string, unknown>;
  const code = getStringProperty(record, "code");
  const message = getStringProperty(record, "message");
  const name = getStringProperty(record, "name");
  if (
    code === WORKFLOW_INVALID_FUNCTION_CODE ||
    name === WORKFLOW_INVALID_FUNCTION_CODE ||
    message?.includes(WORKFLOW_INVALID_FUNCTION_CODE)
  ) {
    return true;
  }
  return hasInvalidWorkflowFunctionCode(record["cause"], depth + 1);
}

function getStringProperty(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function buildInvalidWorkflowFunctionMessage(
  context: WorkflowStartGuidanceContext,
): string {
  const target =
    context.kind === "flow"
      ? `flow "${context.name}"${context.plugName ? ` on plug "${context.plugName}"` : ""}`
      : `${context.kind} workflow "${context.name}"${context.plugName ? ` on plug "${context.plugName}"` : ""}`;

  const startHint =
    context.kind === "flow"
      ? `run your app (for example, npm run dev) and use \`${buildFlowTriggerCommand(context)}\`${context.routePath ? ` or POST ${context.routePath}` : ""}.`
      : `run your app (for example, npm run dev) and send the event through ${context.routePath ?? "the generated Khotan route"}.`;
  const scriptCause =
    context.kind === "flow"
      ? "This usually means `khotanData.flow(...).start(...)` was called from a raw Node/Bun script that imported source workflow files, so Workflow compiler metadata is missing."
      : "This usually means the workflow was started from a raw Node/Bun script that imported source workflow files, so Workflow compiler metadata is missing.";
  const compiledEntry =
    context.kind === "flow"
      ? "You can also call `khotanData.flow(...).start(...)` from compiled Next server code such as a route handler, server action, or cron path."
      : "Webhook processing should enter through the generated Khotan webhook route in the compiled app.";

  return [
    `Khotan could not start the Workflow-backed ${target} because Vercel Workflow rejected the function (${WORKFLOW_INVALID_FUNCTION_CODE}).`,
    scriptCause,
    `Start it from the compiled Workflow/Next runtime instead: ${startHint}`,
    compiledEntry,
    'Ensure `next.config.*` wraps the export with `withWorkflow()` from "workflow/next" and the generated `/api/khotan/[...all]` route is present.',
  ].join(" ");
}

function buildFlowTriggerCommand(
  context: WorkflowStartGuidanceContext,
): string {
  const parts = [
    "npx",
    "khotan-data",
    "flows",
    "trigger",
    formatShellArg(context.name),
  ];

  if (context.variant && context.variant !== "default") {
    parts.push(formatShellArg(context.variant));
  }
  if (context.plugName) {
    parts.push("--plug", formatShellArg(context.plugName));
  }

  return parts.join(" ");
}

function formatShellArg(value: string): string {
  return /^[A-Za-z0-9._:@/-]+$/.test(value) ? value : JSON.stringify(value);
}
