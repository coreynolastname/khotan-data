// ---------------------------------------------------------------------------
// Thin entry point — re-exports everything from the decomposed factory modules
// so that `import ... from "khotan-data/factory"` continues to work unchanged.
// ---------------------------------------------------------------------------

export type {
  ResourceConnectField,
  ResourcePlugParticipation,
  ResourceMappingRegistration,
  ResourceRegistration,
  FlowType,
  KhotanRunStatus,
  KhotanTerminalRunStatus,
  FlowRunResult,
  WebhookEventStatus,
  WebhookDuplicatePolicy,
  WebhookIdempotencyContext,
  WebhookIdempotencyKey,
  WebhookWorkflowReturn,
  BoundPlug,
  BatchPostOptions,
  BindablePlug,
  FlowRunContext,
  FlowWorkflowContext,
  KhotanRunUpdate,
  RunSource,
  FlowHookContext,
  RunSummary,
  FlowHook,
  FactoryFlowRunHook,
  WebhookReceivedContext,
  WebhookReceivedHook,
  FlowVariant,
  FlowRegistration,
  InflowContext,
  OutflowContext,
  RelayContext,
  InflowWorkflow,
  OutflowWorkflow,
  RelayWorkflow,
  InflowConfig,
  OutflowConfig,
  RelayConfig,
  CatchConfig,
  WireConfig,
  WireSubscribeContext,
  WireUnsubscribeContext,
  WireVerifyContext,
  WireRenewContext,
  WireSubscribeResult,
  WireRenewResult,
  WireRegistration,
  WebhookEventSchema,
  WebhookEventFromSchema,
  CatchRegistration,
  PassRegistration,
  WebhookRegistration,
  CacheScope,
  CacheRegistration,
  CacheEntryRecord,
  CacheInstance,
  CatchWorkflowContext,
  PassWorkflowContext,
  KhotanWorkflowContextRef,
  KhotanWorkflowRuntimeHelpers,
  VarField,
  PlugRegistration,
  KhotanAdapter,
  KhotanAuthorize,
  KhotanConfig,
  KhotanHandler,
  WireInstance,
  FlowStartOptions,
  FlowSelectorOptions,
  StuckRunReconcileOptions,
  StuckRunReconcileItem,
  StuckRunReconcileResult,
  FlowInstance,
  KhotanInstance,
} from "./factory/types.js";
export type {
  IngestConfig,
  IngestHeaders,
  IngestIdempotencyClaim,
  IngestIdempotencyStore,
  IngestMappingHelper,
  IngestMappingStore,
  IngestRegistration,
  IngestRequestContext,
  IngestResolvedContext,
  IngestResponse,
  IngestSchema,
  IngestUnresolvedContext,
  InferIngestBody,
} from "./factory/ingest.js";

export {
  inflow,
  outflow,
  relay,
  catchEvent,
  wire,
  bindWorkflowPlug,
  khotanCache,
  khotanMappings,
  khotanRuntimeRegistry,
} from "./factory/types.js";
export type { NextJsRequest, NextJsRouteHandlers } from "./factory/runtime.js";
export {
  contentHash,
  createCursorHelper,
  deltaSkip,
  detectChanges,
  stableStringify,
} from "./factory/load.js";
export type {
  ChangeDetectionOptions,
  ChangeDetectionResult,
  CursorHelper,
  DeltaKey,
  DeltaSkipOptions,
  DeltaSkipResult,
} from "./factory/load.js";
export type {
  WorkflowGetRunFn,
  WorkflowGetWritableFn,
  WorkflowRuntimeConfig,
  WorkflowStartFn,
} from "./factory/workflow.js";
export { deriveCliToken } from "./factory/cli-auth.js";
export { drizzleAdapter } from "./factory/drizzle-adapter.js";
export { verifyHmacSha256 } from "./factory/crypto.js";
export type { VerifyHmacSha256Options } from "./factory/crypto.js";
export {
  configureWorkflowRuntime,
  __setWorkflowStartForTests,
  __setWorkflowGetRunForTests,
  __setWorkflowGetWritableForTests,
  sendUpdate,
} from "./factory/workflow.js";
export { khotan, toNextJsHandler } from "./factory/runtime.js";
export { slackNotifier } from "./factory/notifiers.js";
export { ingest } from "./factory/ingest.js";
