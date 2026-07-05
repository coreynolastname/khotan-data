// ---------------------------------------------------------------------------
// Factory barrel — re-exports all public symbols from the decomposed modules.
// ---------------------------------------------------------------------------

// Types
export type {
  ResourceConnectField,
  ResourcePlugParticipation,
  ResourceMappingRegistration,
  ResourceRegistration,
  FlowType,
  KhotanRunStatus,
  KhotanTerminalRunStatus,
  FlowRunResult,
  BoundPlug,
  PlugVarSelection,
  PlugBindingContext,
  BatchPostOptions,
  BindablePlug,
  FlowRunContext,
  FlowWorkflowContext,
  FlowWorkflowHandler,
  KhotanRunUpdate,
  RunSource,
  FlowHookContext,
  RunSummary,
  FlowHook,
  FlowVariant,
  FlowRegistration,
  InflowContext,
  OutflowContext,
  RelayContext,
  InflowWorkflow,
  OutflowWorkflow,
  RelayWorkflow,
  KhotanPersistedRunUpdate,
  KhotanPersistedRunUpdateInput,
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
  PlugVarProfile,
  PlugRegistration,
  KhotanAdapter,
  KhotanAuthorize,
  KhotanVercelConfig,
  KhotanConfig,
  KhotanHandler,
  WireInstance,
  FlowStartOptions,
  FlowSelectorOptions,
  FlowInstance,
  KhotanInstance,
} from "./types.js";
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
} from "./ingest.js";

// Runtime helpers exported for workflow consumers
export {
  inflow,
  outflow,
  relay,
  catchEvent,
  wire,
  bindWorkflowPlug,
  khotanCache,
  khotanRunUpdates,
  khotanMappings,
} from "./types.js";
export type { NextJsRequest, NextJsRouteHandlers } from "./runtime.js";
export {
  contentHash,
  createCursorHelper,
  deltaSkip,
  detectChanges,
  stableStringify,
} from "./load.js";
export type {
  ChangeDetectionOptions,
  ChangeDetectionResult,
  CursorHelper,
  DeltaKey,
  DeltaSkipOptions,
  DeltaSkipResult,
} from "./load.js";
export type {
  WorkflowGetRunFn,
  WorkflowGetWritableFn,
  WorkflowRuntimeConfig,
  SendUpdateOptions,
  WorkflowStartFn,
} from "./workflow.js";

// CLI auth (deriveCliToken is used by the CLI package)
export { deriveCliToken } from "./cli-auth.js";

// Drizzle adapter
export { drizzleAdapter } from "./drizzle-adapter.js";
export type { KhotanDrizzleDatabase } from "./drizzle-adapter.js";

// Webhook helpers
export { verifyHmacSha256 } from "./crypto.js";
export type { VerifyHmacSha256Options } from "./crypto.js";

// Workflow test seams + sendUpdate
export {
  configureWorkflowRuntime,
  __setWorkflowStartForTests,
  __setWorkflowGetRunForTests,
  __setWorkflowGetWritableForTests,
  sendUpdate,
} from "./workflow.js";

// Core factory
export { khotan, toNextJsHandler } from "./runtime.js";

// Batteries-included lifecycle hook helpers
export { slackNotifier } from "./notifiers.js";

// Inbound destination ingest endpoints
export { ingest } from "./ingest.js";
