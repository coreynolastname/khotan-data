// ---------------------------------------------------------------------------
// Public types — all exported interfaces and type aliases for the factory.
// ---------------------------------------------------------------------------

export type ResourceConnectField = string | [string, ...string[]];

export interface ResourcePlugParticipation {
  uniqueIdentifier: string;
}

export interface ResourceMappingRegistration {
  connectField: ResourceConnectField;
  plugs?: Record<string, ResourcePlugParticipation>;
}

export interface ResourceRegistration {
  name: string;
  description?: string;
  mapping: ResourceMappingRegistration;
}

export type FlowType = "inflow" | "outflow" | "relay" | "webhook";

export type KhotanRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
export type KhotanTerminalRunStatus =
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface FlowRunResult {
  status?: KhotanTerminalRunStatus;
  extracted?: number;
  transformed?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  failed?: number;
  skipped?: number;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BoundPlug {
  get<T>(
    path: string,
    options?: {
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ): Promise<T>;
  post<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<T>;
  batchPost<TResponse = unknown, TRecord = unknown>(
    path: string,
    records: readonly TRecord[],
    options?: BatchPostOptions<TRecord>,
  ): Promise<TResponse[]>;
  put<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<T>;
  patch<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<T>;
  delete<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<T>;
}

export interface BatchPostOptions<TRecord = unknown> {
  batchSize?: number;
  concurrency?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  buildBody?: (records: TRecord[], batchIndex: number) => unknown;
}

export interface BindablePlug {
  get<T>(
    path: string,
    options?: {
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      vars?: Record<string, string>;
      _setVars?: (updates: Record<string, string>) => Promise<void>;
    },
  ): Promise<T>;
  post<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      vars?: Record<string, string>;
      _setVars?: (updates: Record<string, string>) => Promise<void>;
    },
  ): Promise<T>;
  batchPost?<TResponse = unknown, TRecord = unknown>(
    path: string,
    records: readonly TRecord[],
    options?: BatchPostOptions<TRecord> & {
      vars?: Record<string, string>;
      _setVars?: (updates: Record<string, string>) => Promise<void>;
    },
  ): Promise<TResponse[]>;
  put<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      vars?: Record<string, string>;
      _setVars?: (updates: Record<string, string>) => Promise<void>;
    },
  ): Promise<T>;
  patch<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      vars?: Record<string, string>;
      _setVars?: (updates: Record<string, string>) => Promise<void>;
    },
  ): Promise<T>;
  delete<T>(
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      vars?: Record<string, string>;
      _setVars?: (updates: Record<string, string>) => Promise<void>;
    },
  ): Promise<T>;
}

/** How a run was triggered. Distinguishes inbound webhook runs and scheduled
 *  cron runs from manual/programmatic ones. */
export type RunSource = "scheduled" | "manual" | "webhook";

export interface FlowHookContext {
  flow: {
    id: string;
    name: string;
    plugName: string;
    type: FlowType;
    resource?: string | null;
    to?: string | null;
  };
  /** The active variant for the finished run. */
  variant: string;
}

/** Compact summary of a finished run, passed to variant lifecycle hooks. */
export interface RunSummary {
  id: string;
  status: KhotanTerminalRunStatus;
  variant: string;
  source: RunSource;
  durationMs: number;
  extracted: number;
  transformed: number;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  skipped: number;
  error: string | null;
}

/** Lifecycle hook invoked when a run reaches a terminal state. Receives the
 *  flow/variant context and a summary of the finished run. Hook errors are
 *  caught and logged — they never change the recorded run status. */
export type FlowHook = (
  ctx: FlowHookContext,
  run: RunSummary,
) => void | Promise<void>;

/** Factory-level flow lifecycle hook invoked for every registered flow run that
 * reaches a terminal state. Hook errors are caught and logged. */
export type FactoryFlowRunHook = (
  ctx: FlowHookContext,
  run: RunSummary,
) => void | Promise<void>;

export interface WebhookReceivedContext {
  plug: {
    id: string | null;
    name: string;
  };
  wireId: string | null;
  eventType: string;
  event: Record<string, unknown>;
  headers: Record<string, string>;
  receivedAt: Date;
  rawBody: string;
}

/** Factory-level webhook hook invoked once a webhook has passed verification
 * and been parsed. Hook errors are caught and logged. */
export type WebhookReceivedHook = (
  ctx: WebhookReceivedContext,
) => void | Promise<void>;

/** A named run mode for a flow. The variant name *is* the mode — flow code
 *  branches on `ctx.variant`. Each variant may carry its own `schedule` and
 *  terminal-state hooks. */
export interface FlowVariant {
  /** Optional cron schedule. Variants without a schedule are manual-only. */
  schedule?: string;
  /** Invoked when a run for this variant ends `failed` or `partial`. */
  onError?: FlowHook;
  /** Invoked when a run for this variant ends successfully. */
  onComplete?: FlowHook;
}

export interface FlowRunContext<TBody = unknown> {
  plug: BoundPlug;
  flow: {
    id: string;
    name: string;
    plugName: string;
    type: FlowType;
    resource?: string | null;
    to?: string | null;
  };
  /** The active variant for this run. The variant name is the run mode — flow
   *  code branches on this (e.g. "default", "delta", "full", "healthcheck"). */
  variant: string;
  body?: TBody;
  vars: Record<string, string>;
  setVars(updates: Record<string, string>): Promise<void>;
  cache(cacheName: string): CacheInstance;
  mapping(resourceName: string): MappingInstance;
  /**
   * Explicitly finalize the current run using the same lifecycle write path as
   * returning a FlowRunResult. Prefer returning a FlowRunResult from flow code;
   * use this in inline run handlers only when returning a final result is not
   * practical.
   */
  finalize(result?: FlowRunResult): Promise<void>;
}

export interface FlowWorkflowContext<TBody = unknown> {
  flow: {
    id: string;
    name: string;
    plugName: string;
    type: FlowType;
    resource?: string | null;
    to?: string | null;
  };
  /** The active variant for this run. The variant name is the run mode — flow
   *  code branches on this (e.g. "default", "delta", "full", "healthcheck"). */
  variant: string;
  body?: TBody;
  vars: Record<string, string>;
  plugVarsByName?: Record<string, Record<string, string>>;
  khotanRunId: string;
  khotanInstanceId: string;
}

interface FlowWorkflowHandlerBivariance<TBody> {
  bivarianceHack(
    ctx: FlowWorkflowContext<TBody>,
  ): Promise<FlowRunResult | undefined>;
}

export type FlowWorkflowHandler<TBody = unknown> =
  FlowWorkflowHandlerBivariance<TBody>["bivarianceHack"];

export interface KhotanRunUpdate {
  type?: "progress" | "log" | "metric" | "error";
  message: string;
  progress?: number;
  extracted?: number;
  transformed?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  failed?: number;
  metadata?: Record<string, unknown>;
}

export interface FlowRegistration<TBody = unknown> {
  name: string;
  type: FlowType;
  /** Single cron schedule. Mutually exclusive with `variants`: a flow declares
   *  either a top-level `schedule` (implicit `default` variant) OR a `variants`
   *  map, never both. */
  schedule?: string;
  /** Named run modes for this flow. Each variant may carry its own `schedule`
   *  and lifecycle hooks. When omitted, the flow is normalized to a single
   *  `default` variant carrying the top-level `schedule`. */
  variants?: Record<string, FlowVariant>;
  resource?: string;
  to?: string;
  workflow?: FlowWorkflowHandler<TBody>;
  run?(ctx: FlowRunContext<TBody>): Promise<FlowRunResult | undefined>;
}

export interface WireSubscribeContext {
  plug: {
    get<T>(
      path: string,
      options?: {
        params?: Record<string, unknown>;
        headers?: Record<string, string>;
      },
    ): Promise<T>;
    post<T>(
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ): Promise<T>;
    put<T>(
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ): Promise<T>;
    patch<T>(
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ): Promise<T>;
    delete<T>(
      path: string,
      options?: { headers?: Record<string, string> },
    ): Promise<T>;
  };
  callbackUrl: string;
  events: string[];
  wireVars: Record<string, string>;
  setWireVars(updates: Record<string, string>): Promise<void>;
}

export interface WireUnsubscribeContext {
  plug: {
    get<T>(
      path: string,
      options?: {
        params?: Record<string, unknown>;
        headers?: Record<string, string>;
      },
    ): Promise<T>;
    post<T>(
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ): Promise<T>;
    put<T>(
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ): Promise<T>;
    patch<T>(
      path: string,
      options?: { body?: unknown; headers?: Record<string, string> },
    ): Promise<T>;
    delete<T>(
      path: string,
      options?: { headers?: Record<string, string> },
    ): Promise<T>;
  };
  remoteId: string;
  wireVars: Record<string, string>;
  setWireVars(updates: Record<string, string>): Promise<void>;
}

export interface WireVerifyContext {
  headers: Record<string, string>;
  body: string;
  wireVars: Record<string, string>;
}

export interface WireRenewContext extends WireSubscribeContext {
  remoteId: string;
  expiresAt?: string | null;
}

export interface WireSubscribeResult {
  remoteId: string;
  expiresAt?: string | Date | null;
}

export interface WireRenewResult {
  remoteId?: string;
  expiresAt?: string | Date | null;
}

export interface WireRegistration {
  events: string[];
  mode?: "managed" | "manual";
  onSubscribe?(ctx: WireSubscribeContext): Promise<WireSubscribeResult>;
  onUnsubscribe?(ctx: WireUnsubscribeContext): Promise<void>;
  onRenew?(ctx: WireRenewContext): Promise<WireRenewResult>;
  onVerify?(ctx: WireVerifyContext): Promise<boolean>;
}

export interface WebhookEventSchema<TEvent> {
  parse(input: unknown): TEvent;
}

export type WebhookEventFromSchema<TSchema> =
  TSchema extends WebhookEventSchema<infer TEvent>
    ? TEvent
    : Record<string, unknown>;

export interface CatchRegistration<
  TSchema extends WebhookEventSchema<unknown> | undefined =
    | WebhookEventSchema<unknown>
    | undefined,
> {
  type: "catch";
  name: string;
  events?: string[];
  schema?: TSchema;
  workflow: (
    ctx: CatchWorkflowContext<WebhookEventFromSchema<TSchema>>,
  ) => Promise<void>;
}

export interface PassRegistration {
  type: "pass";
  name: string;
  to: string;
  events?: string[];
  workflow: (ctx: PassWorkflowContext) => Promise<void>;
}

export type WebhookRegistration = CatchRegistration | PassRegistration;

export interface CacheScope {
  plug?: string;
  resource?: string;
  flow?: string;
}

export interface CacheRegistration {
  name: string;
  scope?: CacheScope;
  ttl?: string | number;
}

export interface CacheEntryRecord {
  id: string;
  cacheId: string;
  key: string;
  value: unknown;
  expiresAt: Date | null;
  createdAt?: Date | undefined;
  updatedAt?: Date | undefined;
}

export interface CacheInstance {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<T>;
  delete(key: string): Promise<void>;
}

export interface MappingInstance {
  list(params?: { limit?: number; offset?: number; search?: string }): Promise<{
    items: Record<string, unknown>[];
    page: {
      limit: number;
      offset: number;
      hasMore: boolean;
      prevOffset: number;
      nextOffset: number;
      total: number;
    };
  }>;
  lookup(
    connectValue: string | string[],
  ): Promise<Record<string, unknown> | null>;
  lookupByRef(
    plugName: string,
    ref: string,
  ): Promise<Record<string, unknown> | null>;
  upsert(mapping: {
    connectValue: string | string[];
    refs: Record<string, string>;
    metadata?: Record<string, unknown> | null;
    /**
     * Defaults to true for natural-key upserts, preserving the existing
     * partial-ref merge behavior. Pass false to replace the refs object.
     */
    mergeRefs?: boolean;
  }): Promise<Record<string, unknown>>;
  delete(id: string): Promise<void>;
}

export interface CatchWorkflowContext<TEvent = Record<string, unknown>> {
  event: TEvent;
  eventType: string;
  headers: Record<string, string>;
  khotanRunId: string;
  khotanInstanceId: string;
}

export interface PassWorkflowContext {
  event: Record<string, unknown>;
  eventType: string;
  headers: Record<string, string>;
  destVars: Record<string, string>;
  khotanRunId: string;
  khotanInstanceId: string;
}

export interface KhotanWorkflowContextRef {
  khotanInstanceId: string;
}

export interface KhotanWorkflowRuntimeHelpers {
  cache(cacheName: string): CacheInstance;
  mapping(resourceName: string): MappingInstance;
  listMappings: KhotanInstance["listMappings"];
  lookupMapping: KhotanInstance["lookupMapping"];
  upsertMapping: KhotanInstance["upsertMapping"];
  updateMapping: KhotanInstance["updateMapping"];
  deleteMapping: KhotanInstance["deleteMapping"];
}

export interface VarField {
  readonly key: string;
  label: string;
  type: "text" | "password" | "url";
  secret?: boolean;
  hidden?: boolean;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
}

export interface PlugRegistration {
  name: string;
  plug: {
    baseUrl: string;
    authType: string;
    varFields?: readonly VarField[];
    endpoints?: Record<
      string,
      {
        method: string;
        path: string;
        description?: string;
        body?: { _def?: unknown; shape?: Record<string, unknown> };
        query?: { _def?: unknown; shape?: Record<string, unknown> };
        responses?: Record<
          number,
          { _def?: unknown; shape?: Record<string, unknown> }
        >;
      }
    >;
    get<T>(
      path: string,
      options?: {
        params?: Record<string, unknown>;
        headers?: Record<string, string>;
        vars?: Record<string, string>;
        _setVars?: (updates: Record<string, string>) => Promise<void>;
        _skipHooks?: boolean;
      },
    ): Promise<T>;
    post<T>(
      path: string,
      options?: {
        body?: unknown;
        headers?: Record<string, string>;
        vars?: Record<string, string>;
        _setVars?: (updates: Record<string, string>) => Promise<void>;
        _skipHooks?: boolean;
      },
    ): Promise<T>;
    put<T>(
      path: string,
      options?: {
        body?: unknown;
        headers?: Record<string, string>;
        vars?: Record<string, string>;
        _setVars?: (updates: Record<string, string>) => Promise<void>;
        _skipHooks?: boolean;
      },
    ): Promise<T>;
    patch<T>(
      path: string,
      options?: {
        body?: unknown;
        headers?: Record<string, string>;
        vars?: Record<string, string>;
        _setVars?: (updates: Record<string, string>) => Promise<void>;
        _skipHooks?: boolean;
      },
    ): Promise<T>;
    delete<T>(
      path: string,
      options?: {
        headers?: Record<string, string>;
        vars?: Record<string, string>;
        _setVars?: (updates: Record<string, string>) => Promise<void>;
        _skipHooks?: boolean;
      },
    ): Promise<T>;
  };
  vars?: VarField[];
  flows?: FlowRegistration[];
  endpoints?: Record<string, { method: string; path: string }>;
  wires?: WireRegistration[];
  webhooks?: WebhookRegistration[];
  catches?: CatchRegistration[];
  passes?: PassRegistration[];
}

export interface KhotanAdapter {
  upsertPlug(plug: {
    name: string;
    baseUrl: string;
    authType: string;
  }): Promise<{ id: string }>;
  upsertFlow(flow: {
    plugId: string;
    name: string;
    type: string;
    schedule?: string | null;
  }): Promise<{ id: string }>;
  listPlugs(): Promise<Record<string, unknown>[]>;
  getPlug(id: string): Promise<Record<string, unknown> | null>;
  getPlugFlows(plugId: string): Promise<Record<string, unknown>[]>;
  getFlow(flowId: string): Promise<Record<string, unknown> | null>;
  listFlows(): Promise<Record<string, unknown>[]>;
  getRun(runId: string): Promise<Record<string, unknown> | null>;
  listRuns(flowId: string): Promise<Record<string, unknown>[]>;
  listRunsPage(params: {
    limit: number;
    offset: number;
  }): Promise<{ items: Record<string, unknown>[]; hasMore: boolean }>;
  listStuckRuns?(params: {
    flowId?: string | null;
    olderThan: Date;
    statuses: ("pending" | "running")[];
    limit: number;
  }): Promise<Record<string, unknown>[]>;
  claimStuckRun?(params: {
    runId: string;
    olderThan: Date;
    fromStatuses: ("pending" | "running")[];
    toStatus: KhotanTerminalRunStatus;
    completedAt: Date;
    durationMs?: number | null;
    error: string;
  }): Promise<boolean>;
  claimRunTerminal?(params: {
    runId: string;
    fromStatuses: ("pending" | "running")[];
    updates: KhotanTerminalRunUpdate;
  }): Promise<boolean>;

  upsertResource(resource: {
    name: string;
    connectField: ResourceConnectField;
    description?: string | null;
  }): Promise<{ id: string }>;
  upsertCache(cache: {
    name: string;
    scope?: CacheScope | null;
    ttlSeconds?: number | null;
  }): Promise<{ id: string }>;
  getCacheByName(name: string): Promise<Record<string, unknown> | null>;
  getCacheEntry(
    cacheId: string,
    key: string,
  ): Promise<Record<string, unknown> | null>;
  upsertCacheEntry(entry: {
    cacheId: string;
    key: string;
    value: unknown;
    expiresAt?: Date | null;
  }): Promise<{ id: string; created: boolean }>;
  deleteCacheEntry(cacheId: string, key: string): Promise<void>;
  listResources(): Promise<Record<string, unknown>[]>;
  getResource(id: string): Promise<Record<string, unknown> | null>;
  getResourceFlows(resourceId: string): Promise<Record<string, unknown>[]>;

  upsertMapping(mapping: {
    id?: string;
    resourceId: string;
    connectValue: string;
    refs: Record<string, string>;
    metadata?: Record<string, unknown> | null;
    mergeRefs?: boolean;
  }): Promise<{ id: string; created: boolean }>;
  getMapping(id: string): Promise<Record<string, unknown> | null>;
  listMappings(params: {
    resourceId: string;
    limit: number;
    offset: number;
    search?: string;
  }): Promise<{
    items: Record<string, unknown>[];
    hasMore: boolean;
    total: number;
  }>;
  deleteMapping(id: string): Promise<void>;
  lookupMapping(
    params:
      | {
          resourceId: string;
          connectValue: string;
        }
      | {
          resourceId: string;
          plugName: string;
          ref: string;
        },
  ): Promise<Record<string, unknown> | null>;

  updateFlowResourceId(flowId: string, resourceId: string): Promise<void>;
  togglePlugEnabled(plugId: string, enabled: boolean): Promise<void>;
  toggleFlowEnabled(flowId: string, enabled: boolean): Promise<void>;
  toggleWebhookHandlerEnabled(
    handlerId: string,
    enabled: boolean,
  ): Promise<void>;

  insertWire(wire: {
    plugId: string;
    remoteId: string;
    callbackUrl: string;
    eventTypes: string[];
  }): Promise<{ id: string }>;
  upsertWire(wire: { plugId: string }): Promise<{ id: string }>;
  getActiveWire(plugId: string): Promise<Record<string, unknown> | null>;
  getPlugWire(plugId: string): Promise<Record<string, unknown> | null>;
  getWire(wireId: string): Promise<Record<string, unknown> | null>;
  updateWireStatus(
    wireId: string,
    status: "active" | "disabled" | "pending",
  ): Promise<void>;
  updateWireDetails(
    wireId: string,
    details: {
      remoteId: string;
      callbackUrl: string;
      eventTypes: string[];
      status: "active";
    },
  ): Promise<void>;
  getWireMetadata(wireId: string): Promise<string | null>;
  updateWireMetadata(wireId: string, metadata: string): Promise<void>;
  getEncryptedVariables(plugId: string): Promise<string | null>;
  setEncryptedVariables(plugId: string, encrypted: string): Promise<void>;
  clearEncryptedVariables(plugId: string): Promise<void>;

  upsertWebhookHandler(handler: {
    wireId: string;
    name: string;
    type: "catch" | "pass";
    destinationPlugId?: string | null;
  }): Promise<{ id: string }>;
  listWebhookHandlers(wireId: string): Promise<Record<string, unknown>[]>;
  getLatestWebhookHandlerRun(
    handlerId: string,
  ): Promise<Record<string, unknown> | null>;

  insertRun(run: {
    flowId?: string | null;
    wireId?: string | null;
    webhookHandlerId?: string | null;
    workflowRunId?: string | null;
    variant: string;
    source: RunSource;
    status: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<{ id: string }>;
  updateRun(
    runId: string,
    updates: {
      status: KhotanRunStatus;
      workflowRunId?: string | null;
      completedAt?: Date;
      durationMs?: number;
      extracted?: number;
      transformed?: number;
      created?: number;
      updated?: number;
      deleted?: number;
      failed?: number;
      skipped?: number;
      error?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void>;
  insertWebhookEvent(event: {
    wireId: string;
    webhookHandlerId: string;
    khotanRunId: string;
    eventType: string;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
  }): Promise<{ id: string }>;
  listWebhookEventsPage(params: {
    limit: number;
    offset: number;
  }): Promise<{ items: Record<string, unknown>[]; hasMore: boolean }>;
  updateFlowLastRun(
    flowId: string,
    updates: {
      lastRunAt: Date;
      lastRunStatus: KhotanTerminalRunStatus;
    },
  ): Promise<void>;
}

/**
 * Authorize an incoming request to the khotan management API.
 *
 * Return `true` to allow the request, `false` to reject it with `401`.
 * The function receives the raw `Request`, so it composes directly with
 * session libraries such as better-auth:
 *
 * ```ts
 * authorize: async (request) => {
 *   const session = await auth.api.getSession({ headers: request.headers });
 *   return session?.user?.role === "admin";
 * }
 * ```
 *
 * Throwing is treated the same as returning `false`. A rejected request gets a
 * `401` whose JSON body includes `code: "authorize_rejected"` and a `hint`
 * describing the auth model (useful for programmatic callers).
 *
 * NOTE: `KHOTAN_SECRET` is an encryption key, NOT an HTTP credential. Sending it
 * as a `Bearer` token does not authenticate a request — only `authorize` (and
 * the dev-only `KhotanCLI` HMAC token used by the local CLI) can. To trigger a
 * flow from outside the app, either call `khotanData.flow(name).start()` from
 * server code, or send a credential your `authorize` hook accepts.
 *
 * The following routes are intentionally exempt and are NOT passed to
 * `authorize` (they have their own protection):
 * - Inbound webhooks (`POST .../webhook/:plug`) — verified per-plug via `onVerify`.
 * - The cron dispatcher (`.../cron`) — protected by `CRON_SECRET`.
 * - Debug routes (`.../debug...`) — gated by `KHOTAN_DEBUG` and disabled in production.
 */
export type KhotanAuthorize = (request: Request) => boolean | Promise<boolean>;

export interface KhotanConfig {
  adapter: KhotanAdapter;
  plugs: PlugRegistration[];
  resources?: ResourceRegistration[];
  caches?: CacheRegistration[];
  secret?: string;
  /**
   * Gate every management route (plugs, variables, flows, runs, wires,
   * mappings, caches, resources, webhook handlers/events) behind a custom
   * authorization check.
   *
   * Pass a function to gate requests behind your auth layer (e.g. better-auth).
   * Omitting this field in development logs a warning and default-denies
   * management routes with `401`; omitting it in production
   * (`NODE_ENV=production`) throws at startup.
   *
   * Pass `false` only to explicitly opt into publicly accessible management
   * routes during local development. `authorize: false` throws in production.
   * See {@link KhotanAuthorize}.
   */
  authorize?: KhotanAuthorize | false;
  /** Invoked after any registered flow run completes successfully. */
  onFlowRunComplete?: FactoryFlowRunHook;
  /** Invoked after any registered flow run ends failed, partial, or cancelled. */
  onFlowRunFailed?: FactoryFlowRunHook;
  /** Invoked after an inbound webhook passes verification and is accepted. */
  onWebhookReceived?: WebhookReceivedHook;
}

export type KhotanHandler = (request: Request) => Promise<Response>;

export interface WireInstance {
  create(callbackUrl: string): Promise<Record<string, unknown>>;
  delete(wireId: string): Promise<void>;
  renew(wireId?: string): Promise<Record<string, unknown>>;
  get(): Promise<Record<string, unknown> | null>;
}

export interface FlowStartOptions<TBody = unknown> {
  /** Named variant selecting the run mode. Defaults to `default`. Exposed to
   *  flow code as `ctx.variant`. */
  variant?: string | undefined;
  /** @deprecated Use `variant`. Accepted as an alias for one minor release. */
  runType?: string;
  body?: TBody;
}

export interface FlowSelectorOptions {
  plugName?: string;
}

export interface FlowInstance<TBody = unknown> {
  start(options?: FlowStartOptions<TBody>): Promise<Record<string, unknown>>;
  reconcileStuck(
    options?: Omit<StuckRunReconcileOptions, "flowId">,
  ): Promise<StuckRunReconcileResult>;
}

export interface StuckRunReconcileOptions {
  flowId?: string;
  olderThanMs?: number;
  limit?: number;
  statuses?: ("pending" | "running")[];
  status?: Extract<KhotanTerminalRunStatus, "failed" | "cancelled">;
  error?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface StuckRunReconcileItem {
  id: string;
  flowId: string | null;
  workflowRunId: string | null;
  variant: string;
  source: RunSource;
  previousStatus: KhotanRunStatus;
  status: KhotanTerminalRunStatus;
  startedAt: Date | null;
  completedAt: Date;
  durationMs: number | null;
  error: string;
  dryRun: boolean;
  reconciled: boolean;
}

export interface StuckRunReconcileResult {
  ok: true;
  dryRun: boolean;
  checked: number;
  reconciled: number;
  skipped: number;
  olderThan: string;
  items: StuckRunReconcileItem[];
}

export interface KhotanTerminalRunUpdate {
  status: KhotanTerminalRunStatus;
  completedAt: Date;
  durationMs?: number;
  extracted?: number;
  transformed?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  failed?: number;
  skipped?: number;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface KhotanInstance {
  handler: KhotanHandler;
  init(): Promise<void>;
  flow<TBody = unknown>(
    flowNameOrId: string,
    options?: FlowSelectorOptions,
  ): FlowInstance<TBody>;
  reconcileStuckRuns(
    options?: StuckRunReconcileOptions,
  ): Promise<StuckRunReconcileResult>;
  wire(plugName: string): WireInstance;
  cache(cacheName: string): CacheInstance;
  mapping(resourceName: string): MappingInstance;
  listMappings(params: {
    resourceId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<{
    items: Record<string, unknown>[];
    page: {
      limit: number;
      offset: number;
      hasMore: boolean;
      prevOffset: number;
      nextOffset: number;
      total: number;
    };
  }>;
  lookupMapping(
    params:
      | {
          resourceId: string;
          connectValue: string | string[];
        }
      | {
          resourceId: string;
          plugName: string;
          ref: string;
        },
  ): Promise<Record<string, unknown> | null>;
  upsertMapping(mapping: {
    resourceId: string;
    connectValue: string | string[];
    refs: Record<string, string>;
    metadata?: Record<string, unknown> | null;
    mergeRefs?: boolean;
  }): Promise<Record<string, unknown>>;
  updateMapping(
    id: string,
    mapping: {
      resourceId: string;
      connectValue: string | string[];
      refs: Record<string, string>;
      metadata?: Record<string, unknown> | null;
      mergeRefs?: boolean;
    },
  ): Promise<Record<string, unknown>>;
  deleteMapping(id: string): Promise<void>;
  getVars(plugName: string): Promise<Record<string, string>>;
  setVars(plugName: string, vars: Record<string, string>): Promise<void>;
  clearVars(plugName: string): Promise<void>;
  hasVars(plugName: string): Promise<boolean>;
  getVarFields(plugName: string): readonly VarField[];
  getPlug(plugName: string): PlugRegistration["plug"];
  /**
   * Remove this instance from the module-level runtime registry. Call when
   * tearing down in tests, HMR, or multi-instance scenarios to prevent
   * unbounded growth of the registry.
   */
  dispose(): void;
}

export type InflowContext<TBody = unknown> = FlowWorkflowContext<TBody> & {
  flow: FlowWorkflowContext<TBody>["flow"] & { type: "inflow" };
};

export type OutflowContext<TBody = unknown> = FlowWorkflowContext<TBody> & {
  flow: FlowWorkflowContext<TBody>["flow"] & { type: "outflow" };
};

export type RelayContext<TBody = unknown> = FlowWorkflowContext<TBody> & {
  flow: FlowWorkflowContext<TBody>["flow"] & {
    type: "relay";
    to?: string | null;
  };
};

export type InflowWorkflow<TBody = unknown> = (
  ctx: InflowContext<TBody>,
) => Promise<FlowRunResult | undefined>;

export type OutflowWorkflow<TBody = unknown> = (
  ctx: OutflowContext<TBody>,
) => Promise<FlowRunResult | undefined>;

export type RelayWorkflow<TBody = unknown> = (
  ctx: RelayContext<TBody>,
) => Promise<FlowRunResult | undefined>;

export interface InflowConfig<TBody = unknown> {
  /** Unique name for this flow (used for DB tracking and Hub display) */
  name: string;
  /** Logical resource this flow feeds, e.g. "products" */
  resource?: string;
  /** Optional cron schedule. Mutually exclusive with `variants`. */
  schedule?: string;
  /** Named run modes. Mutually exclusive with `schedule`. */
  variants?: Record<string, FlowVariant>;
  /** Durable workflow that extracts, transforms, and loads records */
  workflow: InflowWorkflow<TBody>;
}

export interface OutflowConfig<TBody = unknown> {
  /** Unique name for this flow (used for DB tracking and Hub display) */
  name: string;
  /** Logical resource this flow publishes, e.g. "products" */
  resource?: string;
  /** Optional cron schedule. Mutually exclusive with `variants`. */
  schedule?: string;
  /** Named run modes. Mutually exclusive with `schedule`. */
  variants?: Record<string, FlowVariant>;
  /** Durable workflow that reads app data and writes it to the plug */
  workflow: OutflowWorkflow<TBody>;
}

export interface RelayConfig<TBody = unknown> {
  /** Unique name for this flow (used for DB tracking and Hub display) */
  name: string;
  /** Name of the destination plug/system for humans and future tooling */
  to: string;
  /** Logical resource this flow moves, e.g. "products" */
  resource?: string;
  /** Optional cron schedule. Mutually exclusive with `variants`. */
  schedule?: string;
  /** Named run modes. Mutually exclusive with `schedule`. */
  variants?: Record<string, FlowVariant>;
  /** Durable workflow that reads from source and writes to destination */
  workflow: RelayWorkflow<TBody>;
}

export interface CatchConfig<
  TSchema extends WebhookEventSchema<unknown> | undefined =
    | WebhookEventSchema<unknown>
    | undefined,
> {
  /** Unique name for this catch handler (used for DB tracking and Hub display) */
  name: string;
  /** Event types this catch should receive */
  events?: string[];
  /** Optional schema that validates and types ctx.event for the workflow */
  schema?: TSchema;
  /** Workflow function that processes the event */
  workflow: (
    ctx: CatchWorkflowContext<WebhookEventFromSchema<TSchema>>,
  ) => Promise<void>;
}

export type WireConfig = WireRegistration;

export function inflow<TBody = unknown>(
  config: InflowConfig<TBody>,
): FlowRegistration<TBody> {
  const registration: FlowRegistration<TBody> = {
    name: config.name,
    type: "inflow",
    workflow: config.workflow,
  };
  if (config.resource !== undefined) registration.resource = config.resource;
  if (config.variants) {
    registration.variants = config.variants;
  } else if (config.schedule !== undefined) {
    registration.schedule = config.schedule;
  }
  return registration;
}

export function outflow<TBody = unknown>(
  config: OutflowConfig<TBody>,
): FlowRegistration<TBody> {
  const registration: FlowRegistration<TBody> = {
    name: config.name,
    type: "outflow",
    workflow: config.workflow,
  };
  if (config.resource !== undefined) registration.resource = config.resource;
  if (config.variants) {
    registration.variants = config.variants;
  } else if (config.schedule !== undefined) {
    registration.schedule = config.schedule;
  }
  return registration;
}

export function relay<TBody = unknown>(
  config: RelayConfig<TBody>,
): FlowRegistration<TBody> {
  const registration: FlowRegistration<TBody> = {
    name: config.name,
    type: "relay",
    to: config.to,
    workflow: config.workflow,
  };
  if (config.resource !== undefined) registration.resource = config.resource;
  if (config.variants) {
    registration.variants = config.variants;
  } else if (config.schedule !== undefined) {
    registration.schedule = config.schedule;
  }
  return registration;
}

export function catchEvent<
  TSchema extends WebhookEventSchema<unknown> | undefined = undefined,
>(config: CatchConfig<TSchema>): CatchRegistration<TSchema> {
  const registration: CatchRegistration<TSchema> = {
    type: "catch",
    name: config.name,
    workflow: config.workflow,
  };
  if (config.events !== undefined) registration.events = config.events;
  if (config.schema !== undefined) registration.schema = config.schema;
  return registration;
}

export function wire(config: WireConfig): WireRegistration {
  return config;
}

// ---------------------------------------------------------------------------
// Plug binding helpers
// ---------------------------------------------------------------------------

export function bindPlugWithVars(
  plug: BindablePlug,
  vars: Record<string, string>,
  setVars?: (updates: Record<string, string>) => Promise<void>,
): BoundPlug {
  const opts = (extra?: {
    body?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
  }) => ({
    ...extra,
    vars,
    ...(setVars ? { _setVars: setVars } : {}),
  });

  return {
    get<T>(
      path: string,
      extra?: {
        params?: Record<string, unknown>;
        headers?: Record<string, string>;
      },
    ) {
      return plug.get<T>(path, opts(extra));
    },
    post<T>(
      path: string,
      extra?: {
        body?: unknown;
        headers?: Record<string, string>;
        signal?: AbortSignal;
      },
    ) {
      return plug.post<T>(path, opts(extra));
    },
    async batchPost<TResponse = unknown, TRecord = unknown>(
      path: string,
      records: readonly TRecord[],
      extra?: BatchPostOptions<TRecord>,
    ) {
      if (plug.batchPost) {
        return plug.batchPost<TResponse, TRecord>(path, records, {
          ...extra,
          vars,
          ...(setVars ? { _setVars: setVars } : {}),
        });
      }

      const batchSize = extra?.batchSize ?? 100;
      const concurrency = extra?.concurrency ?? 1;
      if (batchSize < 1) throw new Error("batchSize must be at least 1");
      if (concurrency < 1) throw new Error("concurrency must be at least 1");
      if (records.length === 0) return [];

      const batches: TRecord[][] = [];
      for (let i = 0; i < records.length; i += batchSize) {
        batches.push(records.slice(i, i + batchSize));
      }

      const results: TResponse[] = new Array<TResponse>(batches.length);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const index = next++;
          const batch = batches[index]!;
          const requestOptions: {
            body: unknown;
            headers?: Record<string, string>;
            signal?: AbortSignal;
          } = {
            body: extra?.buildBody ? extra.buildBody(batch, index) : batch,
          };
          if (extra?.headers) requestOptions.headers = extra.headers;
          if (extra?.signal) requestOptions.signal = extra.signal;
          results[index] = await plug.post<TResponse>(
            path,
            opts(requestOptions),
          );
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, batches.length) }, () =>
          worker(),
        ),
      );
      return results;
    },
    put<T>(
      path: string,
      extra?: {
        body?: unknown;
        headers?: Record<string, string>;
        signal?: AbortSignal;
      },
    ) {
      return plug.put<T>(path, opts(extra));
    },
    patch<T>(
      path: string,
      extra?: {
        body?: unknown;
        headers?: Record<string, string>;
        signal?: AbortSignal;
      },
    ) {
      return plug.patch<T>(path, opts(extra));
    },
    delete<T>(
      path: string,
      extra?: {
        body?: unknown;
        headers?: Record<string, string>;
        signal?: AbortSignal;
      },
    ) {
      return plug.delete<T>(path, opts(extra));
    },
  };
}

export function bindWorkflowPlug(
  plug: BindablePlug,
  ctx: FlowWorkflowContext,
  plugName = ctx.flow.plugName,
): BoundPlug {
  const vars =
    plugName === ctx.flow.plugName
      ? ctx.vars
      : (ctx.plugVarsByName?.[plugName] ?? {});

  if (plugName !== ctx.flow.plugName) {
    ctx.plugVarsByName ??= {};
    ctx.plugVarsByName[plugName] = vars;
  }

  return bindPlugWithVars(plug, vars, async (updates) => {
    Object.assign(vars, updates);
  });
}

// ---------------------------------------------------------------------------
// Runtime registry — module-level Map that khotanCache/khotanMappings use
// to find runtime helpers from workflow context.
// ---------------------------------------------------------------------------

export const khotanRuntimeRegistry = new Map<
  string,
  KhotanWorkflowRuntimeHelpers
>();

function getWorkflowRuntimeHelpers(
  ctx: KhotanWorkflowContextRef,
): KhotanWorkflowRuntimeHelpers {
  // Fast path: exact match on the serialized instance id.
  const helpers = khotanRuntimeRegistry.get(ctx.khotanInstanceId);
  if (helpers) {
    return helpers;
  }

  // Defense-in-depth: if exactly one instance is registered, it must be the one
  // the workflow context refers to (the id may differ across isolates if the
  // config identity changed). Resolve to it rather than throwing.
  if (khotanRuntimeRegistry.size === 1) {
    return khotanRuntimeRegistry.values().next().value!;
  }

  throw new Error(
    `Khotan runtime helpers for instance "${ctx.khotanInstanceId}" are not registered ` +
      `(${String(khotanRuntimeRegistry.size)} instance(s) registered, none matched)`,
  );
}

export function khotanCache(
  ctx: KhotanWorkflowContextRef,
  cacheName: string,
): CacheInstance {
  return getWorkflowRuntimeHelpers(ctx).cache(cacheName);
}

export function khotanMappings(ctx: KhotanWorkflowContextRef) {
  const helpers = getWorkflowRuntimeHelpers(ctx);
  return {
    resource: (resourceName: string) => helpers.mapping(resourceName),
    mapping: (resourceName: string) => helpers.mapping(resourceName),
    list: helpers.listMappings,
    lookup: helpers.lookupMapping,
    upsert: helpers.upsertMapping,
    update: helpers.updateMapping,
    delete: helpers.deleteMapping,
  };
}
