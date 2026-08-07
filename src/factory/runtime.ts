import { kd } from "./debug.js";
import { process } from "./debug.js";
import { encryptVars, decryptVars } from "./crypto.js";
import { isCliRequestAuthorized } from "./cli-auth.js";
import {
  matchesCronSchedule,
  startOfUtcMinute,
  isCronRequestAuthorized,
  isDebugEnabled,
} from "./cron.js";
import { serializeEndpoints } from "./zod-introspect.js";
import {
  isPlainObject,
  validateConnectField,
  validateResourcePlugs,
  normalizeCacheScope,
  parseCacheTtlSeconds,
  validateCacheKey,
  coerceCacheEntryRecord,
  isCacheEntryExpired,
  canonicalizeConnectValue,
  deserializeConnectField,
  coerceDate,
  toFlowRunResult,
  getFlowRunCounters,
  resolveTerminalRunStatus,
  readEncryptedJson,
  normalizeFlowVariants,
  DEFAULT_VARIANT,
} from "./helpers.js";
import {
  importWorkflowStart,
  importWorkflowGetRun,
  startWorkflowWithGuidance,
  getWorkflowRunId,
  getWorkflowReturnValue,
  getErrorMessage,
  getKhotanErrorCode,
  isWorkflowCancelledError,
} from "./workflow.js";
import {
  checkKhotanRuntimeDatabaseState,
  formatKhotanRuntimeSchemaCheck,
} from "./runtime-schema.js";
import type {
  KhotanConfig,
  KhotanInstance,
  KhotanHandler,
  KhotanTerminalRunStatus,
  FlowRunResult,
  FlowStartOptions,
  FlowSelectorOptions,
  FlowInstance,
  WireInstance,
  CacheInstance,
  CacheEntryRecord,
  CacheEntryTtl,
  CacheEntryWithMetadata,
  CacheWriteOptions,
  CacheCompareAndSetOptions,
  CacheMutationResult,
  CacheClaimOptions,
  CacheClaimValue,
  CacheClaimResult,
  CacheReleaseOptions,
  CacheReleaseValue,
  CacheReleaseResult,
  CacheDedupeOptions,
  CacheDedupeValue,
  CacheDedupeResult,
  MappingInstance,
  CacheRegistration,
  ResourceRegistration,
  FlowRegistration,
  RelayDestinationContext,
  RelayDestinationRef,
  PlugRegistration,
  WebhookRegistration,
  CatchRegistration,
  PassRegistration,
  VarField,
  FlowVariant,
  FlowHook,
  FlowHookContext,
  RunSource,
  RunSummary,
  StuckRunReconcileOptions,
  StuckRunReconcileResult,
  StuckRunReconcileItem,
  KhotanReconciledRunStatus,
  KhotanRunStatus,
  KhotanTerminalRunUpdate,
  KhotanPersistedRunUpdateInput,
  KhotanPersistedRunUpdate,
  PlugVarSelection,
  PlugVarProfile,
  WebhookDuplicatePolicy,
  WebhookEventStatus,
} from "./types.js";
import { bindPlugWithVars, khotanRuntimeRegistry } from "./types.js";

// ---------------------------------------------------------------------------
// Route table types
// ---------------------------------------------------------------------------

type RouteAuth = "authorize" | "webhook" | "cron" | "debug" | "none";

interface RouteDefinition {
  method: string;
  pattern: string;
  auth: RouteAuth;
  handler: (ctx: RouteContext) => Promise<Response>;
}

interface RouteContext {
  request: Request;
  params: Record<string, string>;
  url: URL;
  searchParams: URLSearchParams;
}

interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

class KhotanInternalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KhotanInternalNotFoundError";
  }
}

class KhotanWireRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KhotanWireRequestError";
  }
}

function matchRoute(
  method: string,
  pathSegments: string[],
  routes: RouteDefinition[],
): RouteMatch | null {
  for (const route of routes) {
    if (route.method !== method && route.method !== "*") continue;

    const patternSegments = route.pattern.split("/").filter(Boolean);
    if (patternSegments.length !== pathSegments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < patternSegments.length; i++) {
      const pat = patternSegments[i]!;
      const seg = pathSegments[i]!;

      if (pat.startsWith(":")) {
        params[pat.slice(1)] = decodeURIComponent(seg);
      } else if (pat !== seg) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { route, params };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// waitUntil helper — uses Vercel's waitUntil when available, else fire-and-forget
// ---------------------------------------------------------------------------

type WaitUntilFn = (promise: Promise<unknown>) => void;

let _resolvedWaitUntil: WaitUntilFn | null = null;

function metadataFromFlowBody(body: unknown): Record<string, unknown> | null {
  if (body === undefined || body === null) return null;
  return isPlainObject(body) ? body : { body };
}

function attachRunFinalizer<T extends object>(
  ctx: T,
  finalize: (result?: FlowRunResult) => Promise<void>,
): T & { finalize(result?: FlowRunResult): Promise<void> } {
  Object.defineProperty(ctx, "finalize", {
    value: finalize,
    enumerable: false,
  });
  return ctx as T & { finalize(result?: FlowRunResult): Promise<void> };
}

function getWaitUntil(): WaitUntilFn {
  if (_resolvedWaitUntil) return _resolvedWaitUntil;
  _resolvedWaitUntil = (_promise: Promise<unknown>) => {
    // fire-and-forget fallback — the promise runs but the runtime may kill it
  };
  return _resolvedWaitUntil;
}

const _vercelFunctionsModule = "@vercel/functions";
const waitUntilReady: Promise<void> = (async () => {
  try {
    const mod = (await import(
      /* webpackIgnore: true */ _vercelFunctionsModule
    )) as { waitUntil?: WaitUntilFn };
    if (typeof mod.waitUntil === "function") {
      _resolvedWaitUntil = mod.waitUntil;
    }
  } catch {
    // Not available — fallback stays
  }
})();

// ---------------------------------------------------------------------------
// khotan factory
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic instance id from the stable, serializable identity of a
 * config. Workflow steps run in a fresh isolate where the flow module is
 * re-imported and `khotan(config)` runs again; deriving the id from config
 * identity (rather than a per-process random uuid) ensures the re-imported module
 * lands on the same registry key so runtime helpers resolve across isolates.
 *
 * Only stable string identity is used (plug/flow/cache/resource names) — never
 * `adapter`/`authorize`/`secret`, which are non-serializable, per-process, or not
 * identity. Lists are sorted for order-independence. A tiny inline FNV-1a hash is
 * used instead of `node:crypto` so this works in any runtime with zero imports.
 */
function deriveInstanceId(config: KhotanConfig): string {
  const { plugs, resources = [], caches = [] } = config;
  const plugNames = plugs.map((p) => p.name).sort();
  const flowNames = plugs
    .flatMap((p) => (p.flows ?? []).map((f) => f.name))
    .sort();
  const cacheNames = caches.map((c) => c.name).sort();
  const resourceNames = resources.map((r) => r.name).sort();

  const identity = JSON.stringify({
    plugs: plugNames,
    flows: flowNames,
    caches: cacheNames,
    resources: resourceNames,
  });

  // If there is no identity at all (degenerate config with no names), fall back
  // to a random id so behavior is never worse than before.
  if (
    plugNames.length === 0 &&
    flowNames.length === 0 &&
    cacheNames.length === 0 &&
    resourceNames.length === 0
  ) {
    return crypto.randomUUID();
  }

  // FNV-1a 32-bit hash — pure, deterministic, no imports, runtime-agnostic.
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `cfg_${hex}`;
}

export function khotan(config: KhotanConfig): KhotanInstance {
  const {
    adapter,
    plugs,
    resources = [],
    caches = [],
    authorize,
    onFlowRunComplete,
    onFlowRunFailed,
    onWebhookReceived,
    vercel,
  } = config;
  const instanceId = deriveInstanceId(config);

  if (authorize === false && process.env["NODE_ENV"] === "production") {
    throw new Error(
      "[khotan] `authorize: false` is not allowed in production. Pass an " +
        "authorization hook to gate management routes before deploying.",
    );
  }

  if (authorize === undefined) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "[khotan] `authorize` is required in production. Pass an authorization hook to gate " +
          "management routes.",
      );
    }
    console.warn(
      "[khotan] No `authorize` hook configured: management routes " +
        "(/api/khotan/*) will reject requests with 401. Pass `authorize` to " +
        "gate them behind your auth layer (e.g. better-auth), or pass " +
        "`authorize: false` to explicitly opt into a public development API. " +
        "Omitting `authorize` throws in production.",
    );
  } else if (authorize === false) {
    console.warn(
      "[khotan] `authorize: false` configured: management routes " +
        "(/api/khotan/*) are publicly accessible. This is only allowed outside " +
        "production; configure a real `authorize` hook before deploying.",
    );
  }
  const authorizeHook =
    authorize === undefined || authorize === false ? null : authorize;

  if (!(config.secret ?? process.env["KHOTAN_SECRET"])) {
    console.warn(
      "[khotan] No `secret`/`KHOTAN_SECRET` configured: plug credentials and " +
        "wire metadata will not be encrypted at rest. Set KHOTAN_SECRET to a " +
        "high-entropy value.",
    );
  }

  function normalizeAbsoluteUrl(
    value: string | null | undefined,
  ): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    return withProtocol.replace(/\/+$/, "");
  }

  const vercelDeploymentUrl = normalizeAbsoluteUrl(
    vercel?.deploymentUrl ??
      process.env["VERCEL_PROJECT_PRODUCTION_URL"] ??
      process.env["VERCEL_URL"],
  );
  const vercelWorkflowRunBaseUrl = normalizeAbsoluteUrl(
    vercel?.workflowRunBaseUrl,
  );

  function getVercelWorkflowRunUrl(
    workflowRunId: string | null,
  ): string | null {
    if (!workflowRunId || !vercelWorkflowRunBaseUrl) return null;
    const encodedRunId = encodeURIComponent(workflowRunId);
    if (vercelWorkflowRunBaseUrl.includes("{workflowRunId}")) {
      return vercelWorkflowRunBaseUrl.replaceAll(
        "{workflowRunId}",
        encodedRunId,
      );
    }
    return `${vercelWorkflowRunBaseUrl}/${encodedRunId}`;
  }

  function addRunOperationalLinks(
    run: Record<string, unknown>,
  ): Record<string, unknown> {
    const workflowRunId = getRunWorkflowId(run);
    return {
      ...run,
      vercelDeploymentUrl,
      vercelWorkflowRunUrl: getVercelWorkflowRunUrl(workflowRunId),
    };
  }

  const plugNames = new Set<string>();
  for (const plug of plugs) {
    if (plugNames.has(plug.name)) {
      throw new Error(`Duplicate plug name: "${plug.name}"`);
    }
    validatePlugProfiles(plug);
    plugNames.add(plug.name);
  }

  const resourceNames = new Set<string>();
  const resourceConfigByName = new Map<string, ResourceRegistration>();
  for (const resource of resources) {
    if (resourceNames.has(resource.name)) {
      throw new Error(`Duplicate resource name: "${resource.name}"`);
    }
    validateConnectField(resource.name, resource.mapping.connectField);
    validateResourcePlugs(resource, plugNames);
    resourceNames.add(resource.name);
    resourceConfigByName.set(resource.name, resource);
  }

  const registeredFlowNames = new Set<string>();
  // Normalized variant maps, keyed by `plugName\0flowName\0type`. Computed (and
  // validated) once at config time so triggering and dispatching can reuse them.
  const flowVariantsByKey = new Map<string, Record<string, FlowVariant>>();
  for (const plug of plugs) {
    if (!plug.flows) continue;
    for (const flow of plug.flows) {
      registeredFlowNames.add(flow.name);
      if (flow.resource && !resourceNames.has(flow.resource)) {
        throw new Error(
          `Flow "${flow.name}" references unknown resource: "${flow.resource}"`,
        );
      }
      // Throws at config time on invalid names or schedule/variants conflict.
      flowVariantsByKey.set(
        `${plug.name}\0${flow.name}\0${flow.type}`,
        normalizeFlowVariants(flow),
      );
    }
  }

  function getFlowVariants(
    plugName: string,
    flowName: string,
    flowType: string,
  ): Record<string, FlowVariant> {
    return (
      flowVariantsByKey.get(`${plugName}\0${flowName}\0${flowType}`) ?? {
        [DEFAULT_VARIANT]: {},
      }
    );
  }

  const cacheStateByName = new Map<
    string,
    { id: string; config: CacheRegistration; ttlSeconds: number | null }
  >();

  for (const cache of caches) {
    if (cacheStateByName.has(cache.name)) {
      throw new Error(`Duplicate cache name: "${cache.name}"`);
    }
    if (typeof cache.name !== "string" || !cache.name.trim()) {
      throw new Error("Cache registrations must declare a non-empty name");
    }

    const normalizedScope = normalizeCacheScope(cache.name, cache.scope);
    if (normalizedScope?.plug && !plugNames.has(normalizedScope.plug)) {
      throw new Error(
        `Cache "${cache.name}" references unknown plug: "${normalizedScope.plug}"`,
      );
    }
    if (
      normalizedScope?.resource &&
      !resourceNames.has(normalizedScope.resource)
    ) {
      throw new Error(
        `Cache "${cache.name}" references unknown resource: "${normalizedScope.resource}"`,
      );
    }
    if (
      normalizedScope?.flow &&
      !registeredFlowNames.has(normalizedScope.flow)
    ) {
      throw new Error(
        `Cache "${cache.name}" references unknown flow: "${normalizedScope.flow}"`,
      );
    }

    cacheStateByName.set(cache.name, {
      id: "",
      config: {
        ...cache,
        name: cache.name.trim(),
        ...(normalizedScope ? { scope: normalizedScope } : {}),
      },
      ttlSeconds: parseCacheTtlSeconds(cache.name, cache.ttl),
    });
  }

  const registeredFlowKeys = new Set(
    plugs.flatMap((plug) =>
      (plug.flows ?? []).map(
        (flow) => `${plug.name}\0${flow.name}\0${flow.type}`,
      ),
    ),
  );

  function isRegisteredFlowRecord(flow: Record<string, unknown>): boolean {
    return (
      typeof flow["plugName"] === "string" &&
      typeof flow["name"] === "string" &&
      typeof flow["type"] === "string" &&
      registeredFlowKeys.has(
        `${flow["plugName"]}\0${flow["name"]}\0${flow["type"]}`,
      )
    );
  }

  function getRegisteredFlowConfig(
    flow: Record<string, unknown>,
  ): FlowRegistration | null {
    const plugName = flow["plugName"];
    const flowName = flow["name"];
    const flowType = flow["type"];
    if (
      typeof plugName !== "string" ||
      typeof flowName !== "string" ||
      typeof flowType !== "string"
    ) {
      return null;
    }

    const plug = plugs.find((candidate) => candidate.name === plugName);
    return (
      plug?.flows?.find(
        (candidate) =>
          candidate.name === flowName && candidate.type === flowType,
      ) ?? null
    );
  }

  function isReadonlyUnknownArray(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
  }

  function getRelayDestinationNames(to: unknown): string[] {
    const names: string[] = [];
    if (typeof to === "string") {
      names.push(to);
    } else if (isReadonlyUnknownArray(to)) {
      for (const value of to) {
        if (typeof value === "string") names.push(value);
      }
    }

    const seen = new Set<string>();
    return names.filter((name) => {
      if (name.length === 0 || seen.has(name)) {
        return false;
      }
      seen.add(name);
      return true;
    });
  }

  function getRelayDestinationRefs(
    to: FlowRegistration["to"] | null | undefined,
  ): RelayDestinationRef[] {
    return getRelayDestinationNames(to).map((name) => ({
      name,
      plugName: name,
    }));
  }

  function serializeFlowVariants(
    variants: Record<string, FlowVariant>,
  ): Record<string, { schedule?: string }> {
    const serialized: Record<string, { schedule?: string }> = {};
    for (const [variantName, variantConfig] of Object.entries(variants)) {
      serialized[variantName] =
        typeof variantConfig.schedule === "string"
          ? { schedule: variantConfig.schedule }
          : {};
    }
    return serialized;
  }

  function getEffectiveDefaultSchedule(
    flow: Record<string, unknown>,
    variants: Record<string, FlowVariant>,
  ): string | null {
    const defaultSchedule = variants[DEFAULT_VARIANT]?.schedule;
    if (typeof defaultSchedule === "string") return defaultSchedule;
    return typeof flow["schedule"] === "string" ? flow["schedule"] : null;
  }

  function enrichRegisteredFlowRecord(
    flow: Record<string, unknown>,
    plugRows: Record<string, unknown>[],
  ): Record<string, unknown> {
    const flowConfig = getRegisteredFlowConfig(flow);
    const variants =
      flowConfig && typeof flow["plugName"] === "string"
        ? getFlowVariants(flow["plugName"], flowConfig.name, flowConfig.type)
        : { [DEFAULT_VARIANT]: {} };
    const effectiveSchedule = getEffectiveDefaultSchedule(flow, variants);
    const to = flowConfig?.to ?? null;
    const destinationPlugs = getRelayDestinationNames(to).map((name) => {
      const plug = plugRows.find((candidate) => candidate["name"] === name);
      return {
        name,
        plugName: name,
        plugId: typeof plug?.["id"] === "string" ? plug["id"] : null,
      };
    });
    const primaryDestinationPlug = destinationPlugs[0] ?? null;

    return {
      ...flow,
      schedule: effectiveSchedule,
      effectiveSchedule,
      variants: serializeFlowVariants(variants),
      to,
      destinationPlugs,
      destinationPlugId: primaryDestinationPlug?.plugId ?? null,
      destinationPlugName: primaryDestinationPlug?.name ?? null,
    };
  }

  async function listRegisteredFlowRecords(
    plugRows?: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const [flows, allPlugRows] = await Promise.all([
      adapter.listFlows(),
      plugRows ? Promise.resolve(plugRows) : adapter.listPlugs(),
    ]);

    return flows
      .filter((flow) => isRegisteredFlowRecord(flow))
      .map((flow) => enrichRegisteredFlowRecord(flow, allPlugRows));
  }

  function isFlowAssociatedWithPlug(
    flow: Record<string, unknown>,
    plugId: string,
  ): boolean {
    if (flow["plugId"] === plugId) return true;
    if (flow["type"] !== "relay") return false;
    if (flow["destinationPlugId"] === plugId) return true;

    const destinationPlugs = flow["destinationPlugs"];
    return (
      Array.isArray(destinationPlugs) &&
      destinationPlugs.some((destination) => {
        if (!destination || typeof destination !== "object") return false;
        return (destination as Record<string, unknown>)["plugId"] === plugId;
      })
    );
  }

  function countAssociatedFlows(
    flows: Record<string, unknown>[],
    plugId: string,
  ): number {
    const flowIds = new Set<string>();
    for (const flow of flows) {
      if (!isFlowAssociatedWithPlug(flow, plugId)) continue;
      const flowId = flow["id"];
      if (typeof flowId === "string") flowIds.add(flowId);
    }
    return flowIds.size;
  }

  function getWebhookHandlersForPlug(
    plug: PlugRegistration,
  ): WebhookRegistration[] {
    const handlers: WebhookRegistration[] = [];
    if (plug.webhooks) handlers.push(...plug.webhooks);
    if (plug.catches) handlers.push(...plug.catches);
    if (plug.passes) handlers.push(...plug.passes);
    return handlers;
  }

  for (const plug of plugs) {
    const webhookHandlers = getWebhookHandlersForPlug(plug);
    if (webhookHandlers.length > 0) {
      const wireConfig = plug.wires?.[0];
      if (!wireConfig?.onVerify) {
        throw new Error(
          `Plug "${plug.name}" has webhook handlers but its wire does not define onVerify. ` +
            `onVerify is required for webhook processing.`,
        );
      }
    }
    for (const handler of webhookHandlers) {
      if (handler.type === "pass") {
        if (!plugNames.has(handler.to)) {
          throw new Error(
            `Pass on plug "${plug.name}" references unknown destination plug: "${handler.to}"`,
          );
        }
      }
    }
  }

  let initialized = false;
  let initPromise: Promise<void> | null = null;
  let runtimeSchemaVerified = false;
  const resourceIdByName = new Map<string, string>();
  const resourceConfigById = new Map<string, ResourceRegistration>();

  const secret = config.secret ?? process.env["KHOTAN_SECRET"] ?? "";

  async function verifyRuntimeSchema(): Promise<void> {
    if (runtimeSchemaVerified || !adapter.getRuntimeSchemaState) return;
    const state = await adapter.getRuntimeSchemaState();
    const check = checkKhotanRuntimeDatabaseState(state);
    if (check.errors.length > 0) {
      throw new Error(
        `[khotan] Runtime database schema check failed.\n${formatKhotanRuntimeSchemaCheck(
          check,
          "Database",
        )}\nRun \`khotan-data doctor\` for details and \`khotan-data migrate --runtime\` to apply Khotan-owned upgrades.`,
      );
    }
    if (check.warnings.length > 0) {
      console.warn(
        `[khotan] Runtime database schema warning.\n${formatKhotanRuntimeSchemaCheck(
          check,
          "Database",
        )}`,
      );
    }
    runtimeSchemaVerified = true;
  }

  async function doInit(): Promise<void> {
    if (initialized) return;
    await waitUntilReady;
    await verifyRuntimeSchema();

    resourceIdByName.clear();
    resourceConfigById.clear();
    for (const resource of resources) {
      const { id } = await adapter.upsertResource({
        name: resource.name,
        connectField: resource.mapping.connectField,
        description: resource.description ?? null,
      });
      resourceIdByName.set(resource.name, id);
      resourceConfigById.set(id, resource);
    }

    for (const [cacheName, cacheState] of cacheStateByName) {
      const { id } = await adapter.upsertCache({
        name: cacheName,
        scope: cacheState.config.scope ?? null,
        ttlSeconds: cacheState.ttlSeconds,
      });
      cacheStateByName.set(cacheName, {
        ...cacheState,
        id,
      });
    }

    for (const plug of plugs) {
      const { id: plugId } = await adapter.upsertPlug({
        name: plug.name,
        baseUrl: plug.plug.baseUrl,
        authType: plug.plug.authType,
      });

      await seedDefaultVarsForPlug(plugId, plug.name);

      if (plug.flows) {
        for (const flow of plug.flows) {
          const { id: flowId } = await adapter.upsertFlow({
            plugId,
            name: flow.name,
            type: flow.type,
            schedule: flow.schedule ?? null,
          });

          if (flow.resource) {
            const resourceId = resourceIdByName.get(flow.resource)!;
            await adapter.updateFlowResourceId(flowId, resourceId);
          }
        }
      }

      if (plug.wires) {
        for (const _wire of plug.wires) {
          const { id: wireId } = await adapter.upsertWire({ plugId });
          const webhookHandlers = getWebhookHandlersForPlug(plug);
          for (const handler of webhookHandlers) {
            if (handler.type === "catch") {
              await adapter.upsertWebhookHandler({
                wireId,
                name: handler.name,
                type: "catch",
              });
              continue;
            }

            const destPlugRow = await adapter
              .listPlugs()
              .then((all) => all.find((row) => row["name"] === handler.to));
            await adapter.upsertWebhookHandler({
              wireId,
              name: handler.name,
              type: "pass",
              destinationPlugId: destPlugRow
                ? (destPlugRow["id"] as string)
                : null,
            });
          }
        }
      }
    }

    initialized = true;
  }

  async function init(): Promise<void> {
    initPromise ??= doInit();
    return initPromise;
  }

  // -------------------------------------------------------------------------
  // Var management
  // -------------------------------------------------------------------------

  const VAR_PROFILES_KEY = "__khotan_profiles";

  interface StoredPlugVarsDocument {
    base: Record<string, string>;
    profiles: Record<string, Record<string, string>>;
  }

  function normalizeProfileName(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  function coerceStringRecord(value: unknown): Record<string, string> {
    if (!isPlainObject(value)) return {};
    const record: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === "string") {
        record[key] = raw;
      }
    }
    return record;
  }

  function normalizePlugProfile(
    profileName: string,
    profile: PlugVarProfile,
  ): PlugVarProfile {
    if (!isPlainObject(profile)) {
      throw new Error(
        `Plug var profile "${profileName}" must be an object with optional vars/defaults`,
      );
    }

    const profileVars = profile["vars"];
    const profileDefaults = profile["defaults"];
    const vars = profileVars ?? profileDefaults;
    if (vars !== undefined && !isPlainObject(vars)) {
      throw new Error(
        `Plug var profile "${profileName}" vars must be an object of strings`,
      );
    }

    return {
      ...(typeof profile["label"] === "string"
        ? { label: profile["label"] }
        : {}),
      ...(profileVars !== undefined
        ? { vars: coerceStringRecord(profileVars) }
        : {}),
      ...(profileDefaults !== undefined
        ? { defaults: coerceStringRecord(profileDefaults) }
        : {}),
    };
  }

  function validatePlugProfiles(plug: PlugRegistration): void {
    const seen = new Set<string>();
    for (const [source, profiles] of [
      ["profiles", plug.profiles],
      ["targets", plug.targets],
    ] as const) {
      if (!profiles) continue;
      if (!isPlainObject(profiles)) {
        throw new Error(`Plug "${plug.name}" ${source} must be an object`);
      }
      for (const [rawName, profile] of Object.entries(profiles)) {
        const profileName = normalizeProfileName(rawName);
        if (!profileName) {
          throw new Error(`Plug "${plug.name}" has an empty profile name`);
        }
        if (seen.has(profileName)) {
          throw new Error(
            `Plug "${plug.name}" declares duplicate profile/target "${profileName}"`,
          );
        }
        normalizePlugProfile(profileName, profile);
        seen.add(profileName);
      }
    }

    const defaultProfile = normalizeProfileName(
      plug.defaultProfile ?? plug.defaultTarget,
    );
    if (defaultProfile && seen.size > 0 && !seen.has(defaultProfile)) {
      throw new Error(
        `Plug "${plug.name}" default profile "${defaultProfile}" is not declared in profiles/targets`,
      );
    }
  }

  function getPlugRegistration(plugName: string): PlugRegistration {
    const plugReg = plugs.find((p) => p.name === plugName);
    if (!plugReg) {
      throw new Error(`Plug "${plugName}" not registered`);
    }
    return plugReg;
  }

  function getProfileSelection(
    plugName: string,
    selection?: PlugVarSelection,
  ): string | undefined {
    return (
      normalizeProfileName(selection?.profile) ??
      normalizeProfileName(selection?.target) ??
      normalizeProfileName(
        getPlugRegistration(plugName).defaultProfile ??
          getPlugRegistration(plugName).defaultTarget,
      )
    );
  }

  function getPlugProfileMap(plugName: string): Map<string, PlugVarProfile> {
    const plugReg = getPlugRegistration(plugName);
    const profiles = new Map<string, PlugVarProfile>();
    for (const source of [plugReg.profiles, plugReg.targets]) {
      if (!source) continue;
      for (const [rawName, rawProfile] of Object.entries(source)) {
        const profileName = normalizeProfileName(rawName);
        if (!profileName) continue;
        profiles.set(
          profileName,
          normalizePlugProfile(profileName, rawProfile),
        );
      }
    }
    return profiles;
  }

  function getProfileDefaultVars(
    plugName: string,
    profileName: string | undefined,
  ): Record<string, string> {
    if (!profileName) return {};
    const profile = getPlugProfileMap(plugName).get(profileName);
    return coerceStringRecord(profile?.vars ?? profile?.defaults ?? {});
  }

  function getBaseDefaultVars(plugName: string): Record<string, string> {
    const defaults: Record<string, string> = {};
    for (const field of getVarFields(plugName)) {
      if (field.defaultValue !== undefined) {
        defaults[field.key] = field.defaultValue;
      }
    }
    return defaults;
  }

  function getDefaultVars(
    plugName: string,
    selection?: PlugVarSelection,
  ): Record<string, string> {
    const profile = getProfileSelection(plugName, selection);
    return {
      ...getBaseDefaultVars(plugName),
      ...getProfileDefaultVars(plugName, profile),
    };
  }

  function parseStoredVarsDocument(value: unknown): StoredPlugVarsDocument {
    const base: Record<string, string> = {};
    const profiles: Record<string, Record<string, string>> = {};
    if (!isPlainObject(value)) return { base, profiles };

    for (const [key, raw] of Object.entries(value)) {
      if (key === VAR_PROFILES_KEY) continue;
      if (typeof raw === "string") {
        base[key] = raw;
      }
    }

    const rawProfiles = value[VAR_PROFILES_KEY];
    if (isPlainObject(rawProfiles)) {
      for (const [rawName, rawVars] of Object.entries(rawProfiles)) {
        const profileName = normalizeProfileName(rawName);
        if (!profileName) continue;
        profiles[profileName] = coerceStringRecord(rawVars);
      }
    }

    return { base, profiles };
  }

  function serializeStoredVarsDocument(
    document: StoredPlugVarsDocument,
  ): Record<string, unknown> {
    const serialized: Record<string, unknown> = { ...document.base };
    const profileEntries = Object.entries(document.profiles).filter(
      ([, vars]) => Object.keys(vars).length > 0,
    );
    if (profileEntries.length > 0) {
      serialized[VAR_PROFILES_KEY] = Object.fromEntries(profileEntries);
    }
    return serialized;
  }

  async function resolvePlugId(plugName: string): Promise<string> {
    await init();
    const allPlugs = await adapter.listPlugs();
    const dbPlug = allPlugs.find((p) => p["name"] === plugName);
    if (!dbPlug) {
      throw new Error(`Plug "${plugName}" not found in database`);
    }
    return dbPlug["id"] as string;
  }

  async function getStoredVarsDocumentByPlugId(
    plugId: string,
  ): Promise<StoredPlugVarsDocument> {
    if (!secret) {
      throw new Error("KHOTAN_SECRET is required for var operations");
    }
    const encrypted = await adapter.getEncryptedVariables(plugId);
    if (!encrypted) return { base: {}, profiles: {} };
    const json = await decryptVars(encrypted, secret);
    return parseStoredVarsDocument(JSON.parse(json) as unknown);
  }

  async function setVarsDocumentByPlugId(
    plugId: string,
    document: StoredPlugVarsDocument,
  ): Promise<void> {
    if (!secret) {
      throw new Error("KHOTAN_SECRET is required for var operations");
    }
    const json = JSON.stringify(serializeStoredVarsDocument(document));
    const encrypted = await encryptVars(json, secret);
    await adapter.setEncryptedVariables(plugId, encrypted);
  }

  async function getStoredVarsByPlugId(
    plugId: string,
    profile?: string,
  ): Promise<Record<string, string>> {
    const document = await getStoredVarsDocumentByPlugId(plugId);
    return profile
      ? { ...document.base, ...(document.profiles[profile] ?? {}) }
      : document.base;
  }

  async function setVarsByPlugId(
    plugId: string,
    vars: Record<string, string>,
    profile?: string,
  ): Promise<void> {
    const document = await getStoredVarsDocumentByPlugId(plugId).catch(
      (): StoredPlugVarsDocument => ({
        base: {},
        profiles: {},
      }),
    );
    if (profile) {
      document.profiles[profile] = coerceStringRecord(vars);
    } else {
      document.base = coerceStringRecord(vars);
    }
    await setVarsDocumentByPlugId(plugId, document);
  }

  async function seedDefaultVarsForPlug(
    plugId: string,
    plugName: string,
  ): Promise<void> {
    const defaults = getBaseDefaultVars(plugName);
    if (!secret || Object.keys(defaults).length === 0) {
      return;
    }

    const storedVars: Record<string, string> = await getStoredVarsByPlugId(
      plugId,
    ).catch(() => ({}));
    const seededVars = { ...defaults, ...storedVars };
    const hasChanges = Object.keys(seededVars).some(
      (key) => seededVars[key] !== storedVars[key],
    );

    if (hasChanges) {
      await setVarsByPlugId(plugId, seededVars);
    }
  }

  async function getVars(
    plugName: string,
    options?: PlugVarSelection,
  ): Promise<Record<string, string>> {
    const plugId = await resolvePlugId(plugName);
    const profile = getProfileSelection(plugName, options);
    const defaults = getDefaultVars(plugName, options);
    const stored = await getStoredVarsByPlugId(plugId, profile);
    return { ...defaults, ...stored };
  }

  async function setVars(
    plugName: string,
    vars: Record<string, string>,
    options?: PlugVarSelection,
  ): Promise<void> {
    const plugId = await resolvePlugId(plugName);
    const profile = getProfileSelection(plugName, options);
    await setVarsByPlugId(plugId, vars, profile);
  }

  async function clearVars(
    plugName: string,
    options?: PlugVarSelection,
  ): Promise<void> {
    const plugId = await resolvePlugId(plugName);
    const profile = getProfileSelection(plugName, options);
    if (profile) {
      const document = await getStoredVarsDocumentByPlugId(plugId).catch(
        (): StoredPlugVarsDocument => ({
          base: {},
          profiles: {},
        }),
      );
      document.profiles = Object.fromEntries(
        Object.entries(document.profiles).filter(([name]) => name !== profile),
      );
      await setVarsDocumentByPlugId(plugId, document);
      return;
    }
    await adapter.clearEncryptedVariables(plugId);
  }

  async function hasVars(
    plugName: string,
    options?: PlugVarSelection,
  ): Promise<boolean> {
    const plugId = await resolvePlugId(plugName);
    const profile = getProfileSelection(plugName, options);
    const encrypted = await adapter.getEncryptedVariables(plugId);
    if (!encrypted) return false;
    if (!profile) return true;
    const document = await getStoredVarsDocumentByPlugId(plugId);
    return Object.keys(document.profiles[profile] ?? {}).length > 0;
  }

  function getVarFields(plugName: string): readonly VarField[] {
    const plugReg = getPlugRegistration(plugName);
    return plugReg.vars ?? plugReg.plug.varFields ?? [];
  }

  function maskVars(
    plugName: string,
    vars: Record<string, string>,
  ): Record<string, string> {
    const fields = getVarFields(plugName);
    return Object.fromEntries(
      Object.entries(vars).map(([key, value]) => {
        const field = fields.find((f) => f.key === key);
        if (field?.secret) {
          return [key, value ? "••••••••" : ""];
        }
        return [key, value];
      }),
    );
  }

  function selectionFromSearchParams(
    searchParams: URLSearchParams,
  ): PlugVarSelection | undefined {
    const profile =
      normalizeProfileName(searchParams.get("profile")) ??
      normalizeProfileName(searchParams.get("target"));
    return profile ? { profile } : undefined;
  }

  function selectionForProfile(
    profile: string | undefined,
  ): PlugVarSelection | undefined {
    return profile ? { profile } : undefined;
  }

  async function getVarProfileSummaries(plugName: string): Promise<
    {
      name: string;
      label?: string;
      configured: boolean;
      default: boolean;
    }[]
  > {
    const configured = getPlugProfileMap(plugName);
    const names = new Set(configured.keys());
    const defaultProfile = normalizeProfileName(
      getPlugRegistration(plugName).defaultProfile ??
        getPlugRegistration(plugName).defaultTarget,
    );
    if (defaultProfile) names.add(defaultProfile);

    let storedProfiles: Record<string, Record<string, string>> = {};
    if (secret) {
      try {
        const plugId = await resolvePlugId(plugName);
        storedProfiles = (await getStoredVarsDocumentByPlugId(plugId)).profiles;
        for (const name of Object.keys(storedProfiles)) names.add(name);
      } catch {
        storedProfiles = {};
      }
    }

    return [...names].sort().map((name) => {
      const profile = configured.get(name);
      const summary = {
        name,
        configured: Object.keys(storedProfiles[name] ?? {}).length > 0,
        default: name === defaultProfile,
      };
      return profile?.label ? { ...summary, label: profile.label } : summary;
    });
  }

  function getPlug(plugName: string): PlugRegistration["plug"] {
    const plugReg = getPlugRegistration(plugName);
    return plugReg.plug;
  }

  // -------------------------------------------------------------------------
  // Resource/mapping helpers
  // -------------------------------------------------------------------------

  async function getRegisteredResourceById(
    resourceId: string,
  ): Promise<ResourceRegistration | null> {
    await init();
    return resourceConfigById.get(resourceId) ?? null;
  }

  async function resolveResourceId(resourceName: string): Promise<string> {
    await init();
    const resourceId = resourceIdByName.get(resourceName);
    if (!resourceId) {
      throw new Error(`Resource "${resourceName}" is not registered`);
    }
    return resourceId;
  }

  async function getRegisteredResourceByName(
    resourceName: string,
  ): Promise<{ id: string; resource: ResourceRegistration }> {
    const id = await resolveResourceId(resourceName);
    const resource = resourceConfigById.get(id);
    if (!resource) {
      throw new Error(`Resource "${resourceName}" is not registered`);
    }
    return { id, resource };
  }

  async function resolveCacheState(cacheName: string) {
    await init();
    const cacheState = cacheStateByName.get(cacheName);
    if (!cacheState?.id) {
      throw new Error(`Cache "${cacheName}" is not registered`);
    }
    return cacheState;
  }

  function resolveCacheExpiresAt(
    cacheName: string,
    defaultTtlSeconds: number | null,
    ttl: CacheEntryTtl | undefined,
    now = new Date(),
  ): Date | null {
    const ttlSeconds =
      ttl === undefined
        ? defaultTtlSeconds
        : ttl === null
          ? null
          : parseCacheTtlSeconds(cacheName, ttl);

    return ttlSeconds !== null
      ? new Date(now.getTime() + ttlSeconds * 1_000)
      : null;
  }

  function resolveCacheWriteExpiresAt(
    cacheName: string,
    defaultTtlSeconds: number | null,
    options: CacheWriteOptions | undefined,
    now = new Date(),
  ): Date | null {
    return resolveCacheExpiresAt(
      cacheName,
      defaultTtlSeconds,
      options?.ttl,
      now,
    );
  }

  function normalizeCacheOwner(owner: string): string {
    if (typeof owner !== "string" || !owner.trim()) {
      throw new Error("Cache claim owner must be a non-empty string");
    }
    return owner.trim();
  }

  function coerceCacheDateOption(
    label: string,
    value: Date | string | null | undefined,
  ): Date | null {
    if (value === null || value === undefined) return null;
    const date = coerceDate(value);
    if (!date) {
      throw new Error(`${label} must be a valid Date or ISO timestamp string`);
    }
    return date;
  }

  function hasOwn(object: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function cacheValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function toCacheEntryWithMetadata<T = unknown>(
    entry: CacheEntryRecord | null,
  ): CacheEntryWithMetadata<T> | null {
    if (!entry || isCacheEntryExpired(entry)) {
      return null;
    }
    const updatedAt = entry.updatedAt ?? entry.createdAt ?? new Date(0);
    const createdAt = entry.createdAt ?? updatedAt;
    return {
      id: entry.id,
      key: entry.key,
      value: entry.value as T,
      version: entry.version ?? `${String(updatedAt.getTime())}:${entry.id}`,
      expiresAt: entry.expiresAt,
      createdAt,
      updatedAt,
    };
  }

  function coerceCacheMutationResult<T = unknown>(result: {
    ok: boolean;
    entry: Record<string, unknown> | null;
  }): CacheMutationResult<T> {
    const entry = result.entry ? coerceCacheEntryRecord(result.entry) : null;
    return {
      ok: result.ok,
      entry: toCacheEntryWithMetadata<T>(entry),
    };
  }

  function createClaimValue<T>(
    value: T,
    owner: string,
    now: Date,
  ): CacheClaimValue<T> {
    return {
      kind: "khotan.cache.claim",
      status: "claimed",
      owner,
      value,
      claimedAt: now.toISOString(),
    };
  }

  function createReleaseValue<T>(
    options: CacheReleaseOptions<T>,
    owner: string,
    cooldownUntil: Date | null,
    now: Date,
  ): CacheReleaseValue<T> {
    return {
      kind: "khotan.cache.claim",
      status: "released",
      owner,
      value: hasOwn(options, "nextValue") ? (options.nextValue ?? null) : null,
      releasedAt: now.toISOString(),
      cooldownUntil: cooldownUntil ? cooldownUntil.toISOString() : null,
    };
  }

  function createDedupeValue<TMetadata>(
    metadata: TMetadata,
    now: Date,
  ): CacheDedupeValue<TMetadata> {
    return {
      kind: "khotan.cache.dedupe",
      metadata,
      markedAt: now.toISOString(),
    };
  }

  function isReleasedClaimAvailable(value: unknown, now: Date): boolean {
    if (!isPlainObject(value)) return false;
    if (
      value["kind"] !== "khotan.cache.claim" ||
      value["status"] !== "released"
    ) {
      return false;
    }
    const cooldownUntil = coerceDate(value["cooldownUntil"]);
    return cooldownUntil === null || cooldownUntil.getTime() <= now.getTime();
  }

  function isActiveClaimOwnedBy(value: unknown, owner: string): boolean {
    return (
      isPlainObject(value) &&
      value["kind"] === "khotan.cache.claim" &&
      value["status"] === "claimed" &&
      value["owner"] === owner
    );
  }

  async function readCacheEntryForState(
    cacheState: { id: string },
    key: string,
  ): Promise<CacheEntryRecord | null> {
    const row = await adapter.getCacheEntry(cacheState.id, key);
    if (!row) {
      return null;
    }
    const entry = coerceCacheEntryRecord(row);
    if (!entry || isCacheEntryExpired(entry)) {
      return null;
    }
    return entry;
  }

  async function writeCacheEntryForState<T = unknown>(
    cacheName: string,
    cacheState: { id: string; ttlSeconds: number | null },
    key: string,
    value: T,
    options: CacheWriteOptions | undefined,
    now = new Date(),
  ): Promise<CacheEntryWithMetadata<T> | null> {
    const expiresAt = resolveCacheWriteExpiresAt(
      cacheName,
      cacheState.ttlSeconds,
      options,
      now,
    );
    return writeCacheEntryWithExpiresAt(cacheState, key, value, expiresAt);
  }

  async function writeCacheEntryWithExpiresAt<T = unknown>(
    cacheState: { id: string },
    key: string,
    value: T,
    expiresAt: Date | null,
  ): Promise<CacheEntryWithMetadata<T> | null> {
    await adapter.upsertCacheEntry({
      cacheId: cacheState.id,
      key,
      value,
      expiresAt,
    });
    return toCacheEntryWithMetadata<T>(
      await readCacheEntryForState(cacheState, key),
    );
  }

  function createCacheInstance(cacheName: string): CacheInstance {
    return {
      async get<T = unknown>(key: string): Promise<T | null> {
        const entry = await readCacheEntry(cacheName, key);
        return entry ? (entry.value as T) : null;
      },
      async getWithMetadata<T = unknown>(
        key: string,
      ): Promise<CacheEntryWithMetadata<T> | null> {
        return toCacheEntryWithMetadata<T>(
          await readCacheEntry(cacheName, key),
        );
      },
      async set<T = unknown>(
        key: string,
        value: T,
        options?: CacheWriteOptions,
      ): Promise<T> {
        validateCacheKey(key);
        const cacheState = await resolveCacheState(cacheName);
        const expiresAt = resolveCacheWriteExpiresAt(
          cacheName,
          cacheState.ttlSeconds,
          options,
        );
        await adapter.upsertCacheEntry({
          cacheId: cacheState.id,
          key,
          value,
          expiresAt,
        });
        return value;
      },
      async compareAndSet<T = unknown>(
        key: string,
        nextValue: T,
        options: CacheCompareAndSetOptions<T> = {},
      ): Promise<CacheMutationResult<T>> {
        validateCacheKey(key);
        const cacheState = await resolveCacheState(cacheName);
        const now = new Date();
        const ifUpdatedAt =
          options.ifUpdatedAt === undefined
            ? undefined
            : (coerceCacheDateOption("ifUpdatedAt", options.ifUpdatedAt) ??
              undefined);
        const ifValueSet = hasOwn(options, "ifValue");
        const expiresAt = resolveCacheWriteExpiresAt(
          cacheName,
          cacheState.ttlSeconds,
          options,
          now,
        );

        if (adapter.compareAndSetCacheEntry) {
          return coerceCacheMutationResult<T>(
            await adapter.compareAndSetCacheEntry({
              cacheId: cacheState.id,
              key,
              value: nextValue,
              expiresAt,
              ifValueSet,
              now,
              ...(options.ifVersion !== undefined
                ? { ifVersion: options.ifVersion }
                : {}),
              ...(ifUpdatedAt !== undefined ? { ifUpdatedAt } : {}),
              ...(ifValueSet ? { ifValue: options.ifValue } : {}),
            }),
          );
        }

        const hasConditions =
          options.ifVersion !== undefined ||
          ifUpdatedAt !== undefined ||
          ifValueSet;
        const current = await readCacheEntryForState(cacheState, key);
        const currentEntry = toCacheEntryWithMetadata<T>(current);

        if (hasConditions) {
          if (!currentEntry) {
            return { ok: false, entry: null };
          }
          if (
            options.ifVersion !== undefined &&
            currentEntry.version !== options.ifVersion
          ) {
            return { ok: false, entry: currentEntry };
          }
          if (
            ifUpdatedAt &&
            currentEntry.updatedAt.getTime() !== ifUpdatedAt.getTime()
          ) {
            return { ok: false, entry: currentEntry };
          }
          if (
            ifValueSet &&
            !cacheValuesEqual(currentEntry.value, options.ifValue)
          ) {
            return { ok: false, entry: currentEntry };
          }
        }

        return {
          ok: true,
          entry: await writeCacheEntryForState<T>(
            cacheName,
            cacheState,
            key,
            nextValue,
            options,
            now,
          ),
        };
      },
      async claim<T = unknown>(
        key: string,
        value: T,
        options: CacheClaimOptions,
      ): Promise<CacheClaimResult<T>> {
        validateCacheKey(key);
        const owner = normalizeCacheOwner(options.owner);
        const cacheState = await resolveCacheState(cacheName);
        const now = new Date();
        const claimValue = createClaimValue(value, owner, now);
        const reclaimWhen =
          options.reclaimWhen === undefined
            ? undefined
            : (coerceCacheDateOption("reclaimWhen", options.reclaimWhen) ??
              undefined);
        const expiresAt = resolveCacheWriteExpiresAt(
          cacheName,
          cacheState.ttlSeconds,
          options,
          now,
        );

        if (adapter.claimCacheEntry) {
          const result = coerceCacheMutationResult<CacheClaimValue<T>>(
            await adapter.claimCacheEntry({
              cacheId: cacheState.id,
              key,
              value: claimValue,
              expiresAt,
              now,
              ...(reclaimWhen !== undefined ? { reclaimWhen } : {}),
            }),
          );
          return { ...result, claimed: result.ok };
        }

        const current = await readCacheEntryForState(cacheState, key);
        const canClaim =
          !current ||
          (reclaimWhen !== undefined &&
            (current.updatedAt?.getTime() ?? 0) <= reclaimWhen.getTime()) ||
          isReleasedClaimAvailable(current.value, now);

        if (!canClaim) {
          return {
            ok: false,
            claimed: false,
            entry: toCacheEntryWithMetadata<CacheClaimValue<T>>(current),
          };
        }

        return {
          ok: true,
          claimed: true,
          entry: await writeCacheEntryForState<CacheClaimValue<T>>(
            cacheName,
            cacheState,
            key,
            claimValue,
            options,
            now,
          ),
        };
      },
      async release<T = unknown>(
        key: string,
        options: CacheReleaseOptions<T>,
      ): Promise<CacheReleaseResult<T>> {
        validateCacheKey(key);
        const owner = normalizeCacheOwner(options.owner);
        const cacheState = await resolveCacheState(cacheName);
        const now = new Date();
        const cooldownUntil = coerceCacheDateOption(
          "cooldownUntil",
          options.cooldownUntil,
        );
        const releaseValue = createReleaseValue(
          options,
          owner,
          cooldownUntil,
          now,
        );
        let expiresAt = resolveCacheWriteExpiresAt(
          cacheName,
          cacheState.ttlSeconds,
          options,
          now,
        );
        if (
          cooldownUntil &&
          expiresAt &&
          expiresAt.getTime() < cooldownUntil.getTime()
        ) {
          expiresAt = cooldownUntil;
        }

        if (adapter.releaseCacheEntry) {
          const result = coerceCacheMutationResult<CacheReleaseValue<T>>(
            await adapter.releaseCacheEntry({
              cacheId: cacheState.id,
              key,
              owner,
              value: releaseValue,
              expiresAt,
              now,
            }),
          );
          return { ...result, released: result.ok };
        }

        const current = await readCacheEntryForState(cacheState, key);
        if (!current || !isActiveClaimOwnedBy(current.value, owner)) {
          return {
            ok: false,
            released: false,
            entry: toCacheEntryWithMetadata<CacheReleaseValue<T>>(current),
          };
        }

        return {
          ok: true,
          released: true,
          entry: await writeCacheEntryWithExpiresAt<CacheReleaseValue<T>>(
            cacheState,
            key,
            releaseValue,
            expiresAt,
          ),
        };
      },
      async markDedupe<TMetadata = Record<string, unknown>>(
        key: string,
        metadata: TMetadata,
        options?: CacheDedupeOptions,
      ): Promise<CacheDedupeResult<TMetadata>> {
        validateCacheKey(key);
        const cacheState = await resolveCacheState(cacheName);
        const now = new Date();
        const value = createDedupeValue(metadata, now);
        const expiresAt = resolveCacheWriteExpiresAt(
          cacheName,
          cacheState.ttlSeconds,
          options,
          now,
        );

        if (adapter.markDedupeCacheEntry) {
          const result = coerceCacheMutationResult<CacheDedupeValue<TMetadata>>(
            await adapter.markDedupeCacheEntry({
              cacheId: cacheState.id,
              key,
              value,
              expiresAt,
              now,
            }),
          );
          return {
            ...result,
            marked: result.ok,
            duplicate: !result.ok,
          };
        }

        const current = await readCacheEntryForState(cacheState, key);
        if (current) {
          return {
            ok: false,
            marked: false,
            duplicate: true,
            entry:
              toCacheEntryWithMetadata<CacheDedupeValue<TMetadata>>(current),
          };
        }

        return {
          ok: true,
          marked: true,
          duplicate: false,
          entry: await writeCacheEntryForState<CacheDedupeValue<TMetadata>>(
            cacheName,
            cacheState,
            key,
            value,
            options,
            now,
          ),
        };
      },
      async delete(key: string): Promise<void> {
        validateCacheKey(key);
        const cacheState = await resolveCacheState(cacheName);
        await adapter.deleteCacheEntry(cacheState.id, key);
      },
    };
  }

  async function readCacheEntry(
    cacheName: string,
    key: string,
  ): Promise<CacheEntryRecord | null> {
    validateCacheKey(key);
    const cacheState = await resolveCacheState(cacheName);
    return readCacheEntryForState(cacheState, key);
  }

  function decorateResourceRecord(
    resource: Record<string, unknown>,
  ): Record<string, unknown> {
    const { connectField: storedConnectField, ...rest } = resource;
    const configResource =
      typeof resource["name"] === "string"
        ? resourceConfigByName.get(resource["name"])
        : undefined;

    return {
      ...rest,
      mapping: {
        connectField:
          configResource?.mapping.connectField ??
          deserializeConnectField(storedConnectField),
        ...(configResource?.mapping.plugs
          ? { plugs: configResource.mapping.plugs }
          : {}),
      },
    };
  }

  function buildMappingPage(params: {
    limit: number;
    offset: number;
    hasMore: boolean;
    total: number;
    items: Record<string, unknown>[];
  }) {
    return {
      items: params.items,
      page: {
        limit: params.limit,
        offset: params.offset,
        hasMore: params.hasMore,
        prevOffset: Math.max(params.offset - params.limit, 0),
        nextOffset: params.offset + params.limit,
        total: params.total,
      },
    };
  }

  async function validateMappingPayload(params: {
    resourceId: string;
    refs: Record<string, string>;
    metadata?: Record<string, unknown> | null;
  }): Promise<ResourceRegistration> {
    if (!isPlainObject(params.refs)) {
      throw new Error("Mapping refs must be an object keyed by plug name");
    }

    for (const [plugName, ref] of Object.entries(params.refs)) {
      if (typeof ref !== "string") {
        throw new Error(`Mapping ref "${plugName}" must be a string`);
      }
    }

    if (params.metadata !== undefined && params.metadata !== null) {
      if (!isPlainObject(params.metadata)) {
        throw new Error("Mapping metadata must be an object when provided");
      }
    }

    const resource = await getRegisteredResourceById(params.resourceId);
    if (!resource) {
      throw new Error(`Resource "${params.resourceId}" is not registered`);
    }

    if (resource.mapping.plugs) {
      const invalidPlugs = Object.keys(params.refs).filter(
        (plugName) => !resource.mapping.plugs?.[plugName],
      );
      if (invalidPlugs.length > 0) {
        throw new Error(
          `Resource "${resource.name}" only allows refs for declared plugs. Invalid refs: ${invalidPlugs.join(", ")}`,
        );
      }
    }

    return resource;
  }

  async function listMappings(params: {
    resourceId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }) {
    const resource = await getRegisteredResourceById(params.resourceId);
    if (!resource) {
      throw new Error(`Resource "${params.resourceId}" is not registered`);
    }

    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const offset = Math.max(params.offset ?? 0, 0);
    const page = await adapter.listMappings({
      resourceId: params.resourceId,
      limit,
      offset,
      ...(params.search?.trim() ? { search: params.search.trim() } : {}),
    });

    return buildMappingPage({
      limit,
      offset,
      hasMore: page.hasMore,
      total: page.total,
      items: page.items,
    });
  }

  async function lookupMapping(
    params:
      | { resourceId: string; connectValue: string | string[] }
      | { resourceId: string; plugName: string; ref: string },
  ): Promise<Record<string, unknown> | null> {
    const resource = await getRegisteredResourceById(params.resourceId);
    if (!resource) {
      throw new Error(`Resource "${params.resourceId}" is not registered`);
    }

    if ("connectValue" in params) {
      return adapter.lookupMapping({
        resourceId: params.resourceId,
        connectValue: canonicalizeConnectValue(resource, params.connectValue),
      });
    }

    if (resource.mapping.plugs && !resource.mapping.plugs[params.plugName]) {
      throw new Error(
        `Resource "${resource.name}" does not declare plug "${params.plugName}"`,
      );
    }

    return adapter.lookupMapping(params);
  }

  async function upsertMapping(mapping: {
    resourceId: string;
    connectValue: string | string[];
    refs: Record<string, string>;
    metadata?: Record<string, unknown> | null;
    mergeRefs?: boolean;
  }): Promise<Record<string, unknown>> {
    const resource = await validateMappingPayload(mapping);
    const result = await adapter.upsertMapping({
      resourceId: mapping.resourceId,
      connectValue: canonicalizeConnectValue(resource, mapping.connectValue),
      refs: mapping.refs,
      metadata: mapping.metadata ?? null,
      ...(mapping.mergeRefs !== undefined
        ? { mergeRefs: mapping.mergeRefs }
        : {}),
    });
    const saved = await adapter.getMapping(result.id);
    if (!saved) {
      throw new Error("Mapping was saved but could not be reloaded");
    }
    return saved;
  }

  async function updateMapping(
    id: string,
    mapping: {
      resourceId: string;
      connectValue: string | string[];
      refs: Record<string, string>;
      metadata?: Record<string, unknown> | null;
      mergeRefs?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const existing = await adapter.getMapping(id);
    if (!existing) {
      throw new Error(`Mapping "${id}" not found`);
    }

    const resource = await validateMappingPayload(mapping);
    await adapter.upsertMapping({
      id,
      resourceId: mapping.resourceId,
      connectValue: canonicalizeConnectValue(resource, mapping.connectValue),
      refs: mapping.refs,
      metadata: mapping.metadata ?? null,
      ...(mapping.mergeRefs !== undefined
        ? { mergeRefs: mapping.mergeRefs }
        : {}),
    });
    const saved = await adapter.getMapping(id);
    if (!saved) {
      throw new Error(`Mapping "${id}" disappeared after update`);
    }
    return saved;
  }

  function createMappingInstance(resourceName: string): MappingInstance {
    return {
      async list(params = {}) {
        const resourceId = await resolveResourceId(resourceName);
        return listMappings({
          resourceId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.search !== undefined ? { search: params.search } : {}),
        });
      },
      async lookup(connectValue) {
        const { id: resourceId } =
          await getRegisteredResourceByName(resourceName);
        return lookupMapping({ resourceId, connectValue });
      },
      async lookupByRef(plugName, ref) {
        const { id: resourceId } =
          await getRegisteredResourceByName(resourceName);
        return lookupMapping({ resourceId, plugName, ref });
      },
      async upsert(mapping) {
        const { id: resourceId } =
          await getRegisteredResourceByName(resourceName);
        return upsertMapping({
          resourceId,
          connectValue: mapping.connectValue,
          refs: mapping.refs,
          ...(mapping.metadata !== undefined
            ? { metadata: mapping.metadata }
            : {}),
          ...(mapping.mergeRefs !== undefined
            ? { mergeRefs: mapping.mergeRefs }
            : {}),
        });
      },
      delete: deleteMapping,
    };
  }

  async function deleteMapping(id: string): Promise<void> {
    const existing = await adapter.getMapping(id);
    if (!existing) {
      throw new Error(`Mapping "${id}" not found`);
    }
    await adapter.deleteMapping(id);
  }

  // -------------------------------------------------------------------------
  // Wire management
  // -------------------------------------------------------------------------

  const WIRE_EXPIRES_AT_VAR = "__khotan_expires_at";

  function wire(plugName: string): WireInstance {
    const plugReg = plugs.find((p) => p.name === plugName);
    if (!plugReg) {
      throw new Error(`Plug "${plugName}" not registered`);
    }
    if (!plugReg.wires || plugReg.wires.length === 0) {
      throw new Error(`Plug "${plugName}" has no wire configuration`);
    }
    const wireConfig = plugReg.wires[0]!;

    function createBoundPlug(
      vars: Record<string, string>,
      _setVars?: (updates: Record<string, string>) => Promise<void>,
    ) {
      return bindPlugWithVars(plugReg!.plug, vars, _setVars, { plugName });
    }

    async function getWireVars(
      wireId: string,
    ): Promise<Record<string, string>> {
      const raw = await adapter.getWireMetadata(wireId);
      return readEncryptedJson(raw, secret, decryptVars);
    }

    async function setWireVars(
      wireId: string,
      vars: Record<string, string>,
    ): Promise<void> {
      const serialized = JSON.stringify(vars);
      const toStore = secret
        ? await encryptVars(serialized, secret)
        : serialized;
      await adapter.updateWireMetadata(wireId, toStore);
    }

    function normalizeWireExpiry(expiresAt: string | Date | null | undefined) {
      if (!expiresAt) return null;
      return expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
    }

    function getWireString(
      record: Record<string, unknown>,
      camelKey: string,
      snakeKey?: string,
    ): string {
      const value = record[camelKey] ?? (snakeKey ? record[snakeKey] : null);
      return typeof value === "string" ? value : "";
    }

    function getWirePlugId(record: Record<string, unknown>): string {
      return getWireString(record, "plugId", "plug_id");
    }

    return {
      async create(callbackUrl: string) {
        await init();
        kd(
          "wire",
          `${plugName}: creating subscription, callbackUrl=${callbackUrl}`,
        );

        const allPlugs = await adapter.listPlugs();
        const dbPlug = allPlugs.find((p) => p["name"] === plugName);
        if (!dbPlug) {
          throw new Error(`Plug "${plugName}" not found in database`);
        }
        const plugId = dbPlug["id"] as string;

        const existingWire = await adapter.getPlugWire(plugId);
        const wireId = existingWire
          ? (existingWire["id"] as string)
          : (
              await adapter.insertWire({
                plugId,
                remoteId: "",
                callbackUrl,
                eventTypes: wireConfig.events,
              })
            ).id;

        const vars = secret ? await getVars(plugName).catch(() => ({})) : {};
        const _setVars = secret
          ? async (updates: Record<string, string>) => {
              Object.assign(vars, updates);
              await setVars(plugName, { ...vars });
            }
          : undefined;
        const boundPlug = createBoundPlug(vars, _setVars);

        let wireVars = await getWireVars(wireId);
        const persistWireVars = async (updates: Record<string, string>) => {
          wireVars = { ...wireVars, ...updates };
          await setWireVars(wireId, wireVars);
        };

        const isManual = wireConfig.mode === "manual";
        if (!isManual && !wireConfig.onSubscribe) {
          throw new Error(
            `Plug "${plugName}" wire is managed but does not define onSubscribe`,
          );
        }

        const result = isManual
          ? { remoteId: `manual:${plugName}` }
          : await wireConfig.onSubscribe!({
              plug: boundPlug,
              callbackUrl,
              events: wireConfig.events,
              wireVars,
              setWireVars: persistWireVars,
            });

        const expiresAt = normalizeWireExpiry(result.expiresAt);
        if (expiresAt) {
          await persistWireVars({ [WIRE_EXPIRES_AT_VAR]: expiresAt });
        }

        kd(
          "wire",
          `${plugName}: subscription created, remoteId=${result.remoteId}`,
        );

        await adapter.updateWireDetails(wireId, {
          remoteId: result.remoteId,
          callbackUrl,
          eventTypes: wireConfig.events,
          status: "active",
        });

        const record = await adapter.getWire(wireId);
        return record!;
      },

      async delete(wireId: string) {
        await init();
        kd("wire", `${plugName}: deleting wire ${wireId}`);
        const allPlugs = await adapter.listPlugs();
        const dbPlug = allPlugs.find((p) => p["name"] === plugName);
        if (!dbPlug) {
          throw new KhotanInternalNotFoundError(
            `Plug "${plugName}" not found in database`,
          );
        }

        const plugId = dbPlug["id"] as string;
        const wireRecord = await adapter.getWire(wireId);
        if (!wireRecord || getWirePlugId(wireRecord) !== plugId) {
          throw new KhotanInternalNotFoundError(
            `Wire for plug "${plugName}" not found`,
          );
        }

        const remoteId = getWireString(wireRecord, "remoteId", "remote_id");
        kd("wire", `${plugName}: remoteId=${remoteId}`);
        if (!remoteId) {
          await adapter.updateWireStatus(wireId, "disabled");
          return;
        }

        const vars = secret ? await getVars(plugName).catch(() => ({})) : {};
        const _setVars = secret
          ? async (updates: Record<string, string>) => {
              Object.assign(vars, updates);
              await setVars(plugName, { ...vars });
            }
          : undefined;
        const boundPlug = createBoundPlug(vars, _setVars);

        const wireVars = await getWireVars(wireId);

        if (wireConfig.mode !== "manual" && wireConfig.onUnsubscribe) {
          let currentWireVars = wireVars;
          await wireConfig.onUnsubscribe({
            plug: boundPlug,
            remoteId,
            wireVars,
            setWireVars: async (updates) => {
              currentWireVars = { ...currentWireVars, ...updates };
              await setWireVars(wireId, currentWireVars);
            },
          });
        }

        kd("wire", `${plugName}: unsubscribed successfully`);
        await adapter.updateWireStatus(wireId, "disabled");
      },

      async renew(wireId?: string) {
        await init();
        if (!wireConfig.onRenew) {
          throw new KhotanWireRequestError(
            `Plug "${plugName}" wire does not define onRenew`,
          );
        }

        const allPlugs = await adapter.listPlugs();
        const dbPlug = allPlugs.find((p) => p["name"] === plugName);
        if (!dbPlug) {
          throw new KhotanInternalNotFoundError(
            `Plug "${plugName}" not found in database`,
          );
        }

        const plugId = dbPlug["id"] as string;
        const wireRecord = wireId
          ? await adapter.getWire(wireId)
          : await adapter.getPlugWire(plugId);
        if (!wireRecord) {
          throw new KhotanInternalNotFoundError(
            `Wire for plug "${plugName}" not found`,
          );
        }
        if (wireId && getWirePlugId(wireRecord) !== plugId) {
          throw new KhotanInternalNotFoundError(
            `Wire for plug "${plugName}" not found`,
          );
        }

        const resolvedWireId = wireRecord["id"] as string;
        const remoteId = getWireString(wireRecord, "remoteId", "remote_id");
        if (!remoteId) {
          throw new KhotanWireRequestError(
            `Wire "${resolvedWireId}" has no remoteId to renew`,
          );
        }

        const vars = secret ? await getVars(plugName).catch(() => ({})) : {};
        const _setVars = secret
          ? async (updates: Record<string, string>) => {
              Object.assign(vars, updates);
              await setVars(plugName, { ...vars });
            }
          : undefined;
        const boundPlug = createBoundPlug(vars, _setVars);

        let wireVars = await getWireVars(resolvedWireId);
        const persistWireVars = async (updates: Record<string, string>) => {
          wireVars = { ...wireVars, ...updates };
          await setWireVars(resolvedWireId, wireVars);
        };

        const callbackUrl = getWireString(wireRecord, "callbackUrl");
        const result = await wireConfig.onRenew({
          plug: boundPlug,
          callbackUrl,
          events: wireConfig.events,
          remoteId,
          expiresAt: wireVars[WIRE_EXPIRES_AT_VAR] ?? null,
          wireVars,
          setWireVars: persistWireVars,
        });

        const nextRemoteId = result.remoteId ?? remoteId;
        const expiresAt = normalizeWireExpiry(result.expiresAt);
        if (expiresAt) {
          await persistWireVars({ [WIRE_EXPIRES_AT_VAR]: expiresAt });
        }

        await adapter.updateWireDetails(resolvedWireId, {
          remoteId: nextRemoteId,
          callbackUrl,
          eventTypes: wireConfig.events,
          status: "active",
        });

        const record = await adapter.getWire(resolvedWireId);
        return record!;
      },

      async get() {
        await init();
        const allPlugs = await adapter.listPlugs();
        const dbPlug = allPlugs.find((p) => p["name"] === plugName);
        if (!dbPlug) return null;

        return adapter.getPlugWire(dbPlug["id"] as string);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Flow execution
  // -------------------------------------------------------------------------

  async function triggerFlowRun(
    flowId: string,
    input: unknown,
    source: RunSource = "manual",
  ): Promise<Response> {
    const flow = await adapter.getFlow(flowId);
    if (
      !flow ||
      typeof flow["plugName"] !== "string" ||
      !plugNames.has(flow["plugName"])
    ) {
      return Response.json({ error: "Flow not found" }, { status: 404 });
    }

    if (flow["enabled"] === false) {
      return Response.json({ error: "Flow is disabled" }, { status: 409 });
    }

    const plugName = flow["plugName"];
    const plugReg = plugs.find((p) => p.name === plugName);
    const flowName = flow["name"];
    const flowType = flow["type"];
    const flowReg = plugReg?.flows?.find(
      (candidate) => candidate.name === flowName && candidate.type === flowType,
    );

    if (!plugReg || !flowReg) {
      return Response.json({ error: "Flow not registered" }, { status: 404 });
    }

    if (flowReg.type === "webhook") {
      return Response.json(
        { error: "Webhook flows are triggered through webhook routes" },
        { status: 400 },
      );
    }

    const requestBody =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {};

    const variants = getFlowVariants(plugName, flowReg.name, flowReg.type);

    // Resolve the variant: explicit `variant`, then deprecated `runType` alias,
    // then `default` if it exists, else error listing the available variants.
    let requestedVariant =
      typeof requestBody["variant"] === "string"
        ? requestBody["variant"]
        : undefined;
    if (
      requestedVariant === undefined &&
      typeof requestBody["runType"] === "string"
    ) {
      requestedVariant = requestBody["runType"];
      console.warn(
        `[khotan] "runType" is deprecated; pass "variant" instead. ` +
          `Treating runType="${requestedVariant}" as variant="${requestedVariant}".`,
      );
    }

    let variant: string;
    if (requestedVariant !== undefined) {
      variant = requestedVariant;
    } else if (DEFAULT_VARIANT in variants) {
      variant = DEFAULT_VARIANT;
    } else {
      return Response.json(
        {
          error: `Flow "${flowReg.name}" requires a variant. Available: ${Object.keys(variants).join(", ")}`,
        },
        { status: 400 },
      );
    }

    const activeVariant: FlowVariant | undefined = variants[variant];

    const runBody = requestBody["body"];
    const requestedRunProfile =
      normalizeProfileName(requestBody["profile"]) ??
      normalizeProfileName(requestBody["target"]);
    const requestedPlugProfiles = {
      ...coerceStringRecord(requestBody["plugProfiles"]),
      ...coerceStringRecord(requestBody["plugTargets"]),
    };
    const relayDestinationNames = getRelayDestinationNames(flowReg.to);
    const relayDestinationRefs = getRelayDestinationRefs(flowReg.to);
    if (requestedRunProfile) {
      requestedPlugProfiles[plugName] ??= requestedRunProfile;
      for (const destinationName of relayDestinationNames) {
        if (plugNames.has(destinationName)) {
          requestedPlugProfiles[destinationName] ??= requestedRunProfile;
        }
      }
    }
    const sourceProfile = getProfileSelection(
      plugName,
      selectionForProfile(requestedPlugProfiles[plugName]),
    );
    const initialMetadata = metadataFromFlowBody(runBody);

    const { id: runId } = await adapter.insertRun({
      flowId,
      variant,
      source,
      status: "running",
      metadata: initialMetadata,
    });
    const startedAt = Date.now();

    await adapter.updateFlowLastRun(flowId, {
      lastRunAt: new Date(startedAt),
      lastRunStatus: "running",
    });

    const hookContext: FlowHookContext = {
      flow: {
        id: flowId,
        name: flowReg.name,
        plugName,
        type: flowReg.type,
        resource: flowReg.resource ?? null,
        to: flowReg.to ?? null,
        ...(relayDestinationRefs.length > 0
          ? { destinations: relayDestinationRefs }
          : {}),
      },
      variant,
    };

    // Invoke terminal-state hooks. Variant hooks preserve the existing
    // per-variant behavior; factory hooks observe every registered flow run.
    // Throwing hooks are caught and logged and never change the recorded run
    // status.
    async function runTerminalHooks(
      status: KhotanTerminalRunStatus,
      counters: ReturnType<typeof getFlowRunCounters>,
      error: string | null,
      durationMs: number,
    ): Promise<void> {
      const hook: FlowHook | undefined =
        status === "completed"
          ? activeVariant?.onComplete
          : status === "failed" || status === "partial"
            ? activeVariant?.onError
            : undefined;

      const summary: RunSummary = {
        id: runId,
        status,
        variant,
        source,
        durationMs,
        ...counters,
        error,
      };

      if (hook) {
        try {
          await hook(hookContext, summary);
        } catch (err) {
          kd("flow", `variant hook for "${variant}" threw`, err);
        }
      }

      const factoryHook =
        status === "completed" ? onFlowRunComplete : onFlowRunFailed;
      if (factoryHook) {
        try {
          await factoryHook(hookContext, summary);
        } catch (err) {
          kd(
            "flow",
            `factory lifecycle hook for "${hookContext.flow.name}" threw`,
            err,
          );
        }
      }
    }

    interface FinalizedRun {
      completedAt: Date;
      counters: ReturnType<typeof getFlowRunCounters>;
      durationMs: number;
      error: string | null;
      metadata: Record<string, unknown> | null;
      status: KhotanTerminalRunStatus;
    }

    let finalizedRun: FinalizedRun | null = null;
    let finalizingRun: Promise<FinalizedRun> | null = null;

    function finalizeOnce(
      finalize: () => Promise<FinalizedRun>,
    ): Promise<FinalizedRun> {
      if (finalizedRun) return Promise.resolve(finalizedRun);
      if (finalizingRun) return finalizingRun;

      finalizingRun = (async () => {
        try {
          finalizedRun = await finalize();
          return finalizedRun;
        } catch (error) {
          if (!finalizedRun) finalizingRun = null;
          throw error;
        }
      })();

      return finalizingRun;
    }

    async function completeRunOk(
      result: FlowRunResult | undefined,
    ): Promise<FinalizedRun> {
      return finalizeOnce(async () => {
        const completedAt = new Date();
        const counters = getFlowRunCounters(result);
        const status = resolveTerminalRunStatus(result, counters);
        const durationMs = Date.now() - startedAt;
        const error = result?.error ?? null;
        const metadata =
          result && "metadata" in result
            ? (result.metadata ?? null)
            : initialMetadata;

        // Guarded terminal transition so an interrupted run that a stuck-run
        // reconciler already claimed is not double-finalized.
        const transitioned = await claimTerminalRun(runId, {
          status,
          completedAt,
          durationMs,
          ...counters,
          error,
          metadata,
        });

        if (transitioned) {
          await adapter.updateFlowLastRun(flowId, {
            lastRunAt: completedAt,
            lastRunStatus: status,
          });
          await runTerminalHooks(status, counters, error, durationMs);
        }

        return {
          completedAt,
          counters,
          durationMs,
          error,
          metadata,
          status,
        };
      });
    }

    async function completeRunFailed(error: unknown) {
      if (finalizedRun) return finalizedRun.error ?? getErrorMessage(error);
      const finalRun = await finalizeOnce(async () => {
        const completedAt = new Date();
        const message = getErrorMessage(error);
        const status: KhotanTerminalRunStatus = isWorkflowCancelledError(error)
          ? "cancelled"
          : "failed";
        const durationMs = Date.now() - startedAt;
        const counters = {
          ...getFlowRunCounters(undefined),
          failed: status === "failed" ? 1 : 0,
        };
        const transitioned = await claimTerminalRun(runId, {
          status,
          completedAt,
          durationMs,
          failed: counters.failed,
          error: message,
        });
        if (transitioned) {
          await adapter.updateFlowLastRun(flowId, {
            lastRunAt: completedAt,
            lastRunStatus: status,
          });
          await runTerminalHooks(status, counters, message, durationMs);
        }
        return {
          completedAt,
          counters,
          durationMs,
          error: message,
          metadata: initialMetadata,
          status,
        };
      });
      return finalRun.error ?? getErrorMessage(error);
    }

    const finalizeRun = async (result?: FlowRunResult): Promise<void> => {
      await completeRunOk(result);
    };

    function observeWorkflowCompletion(
      workflowResult: unknown,
      workflowRunId: string | null,
    ) {
      const completionWork = (async () => {
        let returnValue = getWorkflowReturnValue(workflowResult);

        if (!returnValue && workflowRunId) {
          try {
            const getRun = await importWorkflowGetRun();
            returnValue = getWorkflowReturnValue(getRun(workflowRunId));
          } catch (error) {
            kd(
              "flow",
              `Failed to observe workflow run ${workflowRunId}`,
              error,
            );
            return;
          }
        }

        if (!returnValue) return;

        try {
          const value = await returnValue;
          await completeRunOk(toFlowRunResult(value));
        } catch (error: unknown) {
          await completeRunFailed(error);
        }
      })().catch((error: unknown) => {
        kd("flow", `Failed to reconcile workflow run ${runId}`, error);
      });

      getWaitUntil()(completionWork);
    }

    try {
      const sourceSelection = sourceProfile
        ? { profile: sourceProfile }
        : undefined;
      const vars = secret
        ? await getVars(plugName, sourceSelection).catch(() => ({}))
        : {};
      const setFlowVars = async (updates: Record<string, string>) => {
        Object.assign(vars, updates);
        await setVars(plugName, { ...vars }, sourceSelection);
      };
      const boundPlug = bindPlugWithVars(
        plugReg.plug,
        vars,
        secret ? setFlowVars : undefined,
        {
          plugName,
          ...(sourceProfile ? { profile: sourceProfile } : {}),
          ...(sourceProfile ? { target: sourceProfile } : {}),
        },
      );
      const plugProfilesByName: Record<string, string | undefined> = {};
      const plugVarsByName: Record<string, Record<string, string>> = {
        [plugName]: vars,
      };
      const plugVarProfilesByName: Record<
        string,
        Record<string, Record<string, string>>
      > = {};
      if (sourceProfile) {
        plugProfilesByName[plugName] = sourceProfile;
        plugVarProfilesByName[plugName] = { [sourceProfile]: vars };
      }
      const destinations: RelayDestinationContext[] = [];
      for (const destinationName of relayDestinationNames) {
        const destinationProfile = getProfileSelection(
          destinationName,
          selectionForProfile(requestedPlugProfiles[destinationName]),
        );
        const destinationVars =
          secret && plugNames.has(destinationName)
            ? await getVars(
                destinationName,
                destinationProfile
                  ? { profile: destinationProfile }
                  : undefined,
              ).catch(() => ({}))
            : {};
        plugVarsByName[destinationName] = destinationVars;
        if (destinationProfile && plugNames.has(destinationName)) {
          plugProfilesByName[destinationName] = destinationProfile;
          plugVarProfilesByName[destinationName] = {
            [destinationProfile]: destinationVars,
          };
        }

        const destinationContext: RelayDestinationContext = {
          name: destinationName,
          plugName: destinationName,
          vars: destinationVars,
        };
        if (destinationProfile) {
          destinationContext.profile = destinationProfile;
          destinationContext.target = destinationProfile;
        }
        destinations.push(destinationContext);
      }

      const flowContext = {
        id: flowId,
        name: flowReg.name,
        plugName,
        type: flowReg.type,
        resource: flowReg.resource ?? null,
        to: flowReg.to ?? null,
        ...(relayDestinationRefs.length > 0
          ? { destinations: relayDestinationRefs }
          : {}),
      };

      if (flowReg.workflow) {
        const startWorkflow = await importWorkflowStart();
        const result = await startWorkflowWithGuidance(
          startWorkflow,
          flowReg.workflow,
          [
            {
              flow: flowContext,
              variant,
              body: runBody,
              vars,
              plugVarsByName,
              profile: sourceProfile,
              target: sourceProfile,
              plugProfilesByName,
              plugVarProfilesByName,
              ...(destinations.length > 0 ? { destinations } : {}),
              khotanRunId: runId,
              khotanInstanceId: instanceId,
            },
          ],
          {
            kind: "flow",
            name: flowReg.name,
            plugName,
            variant,
            routePath: `/api/khotan/flows/${flowId}/runs`,
          },
        );
        const workflowRunId = getWorkflowRunId(result);

        if (workflowRunId) {
          await adapter.updateRun(runId, {
            status: "running",
            workflowRunId,
          });
        }

        observeWorkflowCompletion(result, workflowRunId);

        return Response.json({
          id: runId,
          flowId,
          workflowRunId,
          status: "running",
          variant,
          ...(sourceProfile ? { profile: sourceProfile } : {}),
          source,
        });
      }

      const result = await flowReg.run?.(
        attachRunFinalizer(
          {
            plug: boundPlug,
            flow: flowContext,
            variant,
            profile: sourceProfile,
            target: sourceProfile,
            body: runBody,
            vars,
            setVars: setFlowVars,
            ...(destinations.length > 0 ? { destinations } : {}),
            cache: createCacheInstance,
            mapping: createMappingInstance,
          },
          finalizeRun,
        ),
      );
      const runResult = toFlowRunResult(result);

      const { counters, error, metadata, status } =
        await completeRunOk(runResult);

      return Response.json({
        id: runId,
        flowId,
        status,
        variant,
        ...(sourceProfile ? { profile: sourceProfile } : {}),
        source,
        ...counters,
        error,
        metadata,
      });
    } catch (error) {
      const message = await completeRunFailed(error);
      const code = getKhotanErrorCode(error);
      return Response.json(
        {
          id: runId,
          flowId,
          status: "failed",
          error: message,
          ...(code ? { code } : {}),
        },
        { status: 500 },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cron scheduling
  // -------------------------------------------------------------------------

  function isFlowOverdue(
    schedule: string,
    lastRunAt: Date,
    now: Date,
  ): boolean {
    const elapsedMs = now.getTime() - lastRunAt.getTime();
    if (elapsedMs <= 0) return false;

    if (matchesCronSchedule(schedule, now)) return true;

    const intervalMs = estimateCronIntervalMs(schedule);
    return elapsedMs >= intervalMs;
  }

  function estimateCronIntervalMs(schedule: string): number {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return 60_000;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
      if (month !== "*") return 30 * 24 * 60 * 60_000;
      if (dayOfMonth !== "*" || dayOfWeek !== "*") return 24 * 60 * 60_000;
    }

    if (hour !== "*") {
      const hourStep = parseStepInterval(hour!, 24);
      if (minute !== "*") {
        return hourStep * 60 * 60_000;
      }
      return hourStep * 60 * 60_000;
    }

    if (minute !== "*") {
      const minuteStep = parseStepInterval(minute!, 60);
      return minuteStep * 60_000;
    }

    return 60_000;
  }

  function parseStepInterval(field: string, max: number): number {
    if (field.includes("/")) {
      const step = Number.parseInt(field.split("/")[1] ?? "", 10);
      if (Number.isFinite(step) && step > 0) return step;
    }

    if (field.includes(",")) {
      const values = field
        .split(",")
        .map((v) => Number.parseInt(v.trim(), 10))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (values.length >= 2) {
        let minGap = max;
        for (let i = 1; i < values.length; i++) {
          minGap = Math.min(minGap, values[i]! - values[i - 1]!);
        }
        return minGap;
      }
    }

    const parsed = Number.parseInt(field, 10);
    if (Number.isFinite(parsed)) return max;

    return max;
  }

  function getLastTriggeredAt(flow: Record<string, unknown>): Date | null {
    const lastRunAt = coerceDate(flow["lastRunAt"]);
    if (lastRunAt) return lastRunAt;
    const createdAt = coerceDate(flow["createdAt"]);
    if (createdAt) return createdAt;
    return null;
  }

  async function dispatchScheduledFlows(options: { now?: Date } = {}) {
    await init();

    const now = options.now ?? new Date();
    const tickAt = startOfUtcMinute(now);

    const registeredFlows = (await adapter.listFlows()).filter((flow) =>
      isRegisteredFlowRecord(flow),
    );

    const triggered: Record<string, unknown>[] = [];
    const skipped: Record<string, unknown>[] = [];
    let evaluated = 0;

    for (const flow of registeredFlows) {
      const flowId = typeof flow["id"] === "string" ? flow["id"] : null;
      const flowName = typeof flow["name"] === "string" ? flow["name"] : null;
      const plugName =
        typeof flow["plugName"] === "string" ? flow["plugName"] : null;
      const flowType = typeof flow["type"] === "string" ? flow["type"] : null;

      if (!flowId || !flowName || !plugName || !flowType) continue;

      const variants = getFlowVariants(plugName, flowName, flowType);

      // Lazily loaded per-variant baseline source: the flow's run history.
      let runsForFlow: Record<string, unknown>[] | null = null;

      for (const [variantName, variantConfig] of Object.entries(variants)) {
        const schedule = variantConfig.schedule?.trim();
        // Variants without a schedule are manual-only and never auto-fire.
        if (!schedule) continue;

        evaluated++;

        if (flow["enabled"] === false) {
          skipped.push({
            flowId,
            flowName,
            plugName,
            variant: variantName,
            schedule,
            reason: "disabled",
          });
          continue;
        }

        runsForFlow ??= await adapter.listRuns(flowId);
        const lastVariantRun = runsForFlow.find(
          (run) => run["variant"] === variantName,
        );
        const lastTriggered =
          coerceDate(lastVariantRun?.["startedAt"]) ?? getLastTriggeredAt(flow);

        if (!lastTriggered) {
          skipped.push({
            flowId,
            flowName,
            plugName,
            variant: variantName,
            schedule,
            reason: "no_baseline",
          });
          continue;
        }

        let overdue: boolean;
        try {
          overdue = isFlowOverdue(schedule, lastTriggered, tickAt);
        } catch (error) {
          skipped.push({
            flowId,
            flowName,
            plugName,
            variant: variantName,
            schedule,
            reason: "invalid_schedule",
            detail: getErrorMessage(error),
          });
          continue;
        }

        if (!overdue) {
          skipped.push({
            flowId,
            flowName,
            plugName,
            variant: variantName,
            schedule,
            reason: "not_due",
          });
          continue;
        }

        const response = await triggerFlowRun(
          flowId,
          { variant: variantName },
          "scheduled",
        );
        const payload = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;

        if (!response.ok) {
          skipped.push({
            flowId,
            flowName,
            plugName,
            variant: variantName,
            schedule,
            reason: "trigger_failed",
            status: response.status,
            detail:
              typeof payload["error"] === "string"
                ? payload["error"]
                : response.statusText,
          });
          continue;
        }

        triggered.push({
          flowId,
          flowName,
          plugName,
          variant: variantName,
          schedule,
          runId: payload["id"] ?? null,
          workflowRunId: payload["workflowRunId"] ?? null,
          status:
            typeof payload["status"] === "string"
              ? payload["status"]
              : "running",
        });
      }
    }

    return {
      ok: true,
      tickAt: tickAt.toISOString(),
      evaluated,
      triggered,
      skipped,
    };
  }

  // -------------------------------------------------------------------------
  // Flow instance (programmatic)
  // -------------------------------------------------------------------------

  async function resolveFlowId(
    flowNameOrId: string,
    options: FlowSelectorOptions = {},
  ): Promise<string> {
    await init();

    const byId = await adapter.getFlow(flowNameOrId);
    if (
      byId &&
      typeof byId["plugName"] === "string" &&
      plugNames.has(byId["plugName"])
    ) {
      return flowNameOrId;
    }

    const matches = (await adapter.listFlows()).filter((flow) => {
      if (flow["name"] !== flowNameOrId) return false;
      if (!isRegisteredFlowRecord(flow)) return false;
      return !options.plugName || flow["plugName"] === options.plugName;
    });

    if (matches.length === 0) {
      const suffix = options.plugName ? ` on plug "${options.plugName}"` : "";
      throw new Error(`Flow "${flowNameOrId}"${suffix} not found`);
    }

    if (matches.length > 1) {
      const plugsStr = matches
        .map((flow) => String(flow["plugName"]))
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `Flow "${flowNameOrId}" is registered on multiple plugs (${plugsStr}). Pass { plugName } to select one.`,
      );
    }

    const id = matches[0]?.["id"];
    if (typeof id !== "string") {
      throw new Error(`Flow "${flowNameOrId}" has no database ID`);
    }

    return id;
  }

  function flow(
    flowNameOrId: string,
    selectorOptions: FlowSelectorOptions = {},
  ): FlowInstance {
    return {
      async start(startOptions: FlowStartOptions = {}) {
        const flowId = await resolveFlowId(flowNameOrId, selectorOptions);
        const response = await triggerFlowRun(flowId, startOptions, "manual");
        const payload: unknown = await response.json().catch(() => ({}));

        if (!response.ok) {
          const message =
            payload && typeof payload === "object" && "error" in payload
              ? String(payload.error)
              : `Failed to start flow "${flowNameOrId}"`;
          const error = new Error(message);
          if (
            payload &&
            typeof payload === "object" &&
            "code" in payload &&
            typeof payload.code === "string"
          ) {
            Object.assign(error, { code: payload.code });
          }
          throw error;
        }

        return payload as Record<string, unknown>;
      },
      async reconcileStuck(options = {}) {
        const flowId = await resolveFlowId(flowNameOrId, selectorOptions);
        return reconcileStuckRuns({ ...options, flowId });
      },
    };
  }

  // -------------------------------------------------------------------------
  // Workflow run helpers
  // -------------------------------------------------------------------------

  async function getRunWithWorkflowStatus(
    runId: string,
  ): Promise<Record<string, unknown> | null> {
    const run = await adapter.getRun(runId);
    if (!run) return null;

    const workflowRunId =
      typeof run["workflowRunId"] === "string" ? run["workflowRunId"] : null;

    if (!workflowRunId) {
      return addRunOperationalLinks({ ...run, workflowStatus: null });
    }

    try {
      const getRun = await importWorkflowGetRun();
      const workflowRun = getRun(workflowRunId);
      const workflowStatus = workflowRun.status
        ? await workflowRun.status
        : null;
      const reconciledRun = await reconcileRunWithWorkflowTerminalStatus(
        run,
        workflowStatus,
      );
      return addRunOperationalLinks({ ...reconciledRun, workflowStatus });
    } catch (error) {
      return addRunOperationalLinks({
        ...run,
        workflowStatus: null,
        workflowError: getErrorMessage(error),
      });
    }
  }

  function getRunWorkflowId(run: Record<string, unknown>): string | null {
    return typeof run["workflowRunId"] === "string"
      ? run["workflowRunId"]
      : null;
  }

  function getRunId(run: Record<string, unknown>): string | null {
    return typeof run["id"] === "string" ? run["id"] : null;
  }

  function getRunFlowId(run: Record<string, unknown>): string | null {
    return typeof run["flowId"] === "string" ? run["flowId"] : null;
  }

  function coerceRunSource(value: unknown): RunSource {
    return value === "scheduled" || value === "webhook" ? value : "manual";
  }

  function coerceRunStatus(value: unknown): KhotanRunStatus | null {
    return value === "pending" ||
      value === "running" ||
      value === "completed" ||
      value === "partial" ||
      value === "failed" ||
      value === "cancelled"
      ? value
      : null;
  }

  function coerceWorkflowTerminalStatus(
    value: unknown,
  ): Extract<
    KhotanTerminalRunStatus,
    "completed" | "failed" | "cancelled"
  > | null {
    return value === "completed" || value === "failed" || value === "cancelled"
      ? value
      : null;
  }

  function isTerminalRunStatus(
    status: KhotanRunStatus | null,
  ): status is KhotanTerminalRunStatus {
    return (
      status === "completed" ||
      status === "partial" ||
      status === "failed" ||
      status === "cancelled"
    );
  }

  function serializeRunUpdateForStream(
    update: KhotanPersistedRunUpdate,
  ): string {
    const payload: Record<string, unknown> = {
      index: update.index,
      timestamp: update.timestamp.toISOString(),
      type: update.type,
      message: update.message,
    };
    if (update.counters) {
      Object.assign(payload, update.counters);
    }
    if (update.metadata) {
      payload["metadata"] = update.metadata;
    }
    if (update.namespace) {
      payload["namespace"] = update.namespace;
    }
    return `${JSON.stringify(payload)}\n`;
  }

  function streamFromRunUpdates(
    updates: KhotanPersistedRunUpdate[],
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const update of updates) {
          controller.enqueue(
            encoder.encode(serializeRunUpdateForStream(update)),
          );
        }
        controller.close();
      },
    });
  }

  const NON_TERMINAL_RUN_STATUSES: ("pending" | "running")[] = [
    "pending",
    "running",
  ];

  function isNonTerminalRunStatus(
    status: KhotanRunStatus | null,
  ): status is "pending" | "running" {
    return status === "pending" || status === "running";
  }

  function getRunVariant(run: Record<string, unknown>): string {
    return typeof run["variant"] === "string"
      ? run["variant"]
      : DEFAULT_VARIANT;
  }

  function getRunStartedAt(run: Record<string, unknown>): Date | null {
    return coerceDate(run["startedAt"]);
  }

  function getRunDurationMs(
    run: Record<string, unknown>,
    completedAt: Date,
  ): number | null {
    const startedAt = getRunStartedAt(run);
    return startedAt
      ? Math.max(completedAt.getTime() - startedAt.getTime(), 0)
      : null;
  }

  async function claimTerminalRun(
    runId: string,
    updates: KhotanTerminalRunUpdate,
  ): Promise<boolean> {
    if (adapter.claimRunTerminal) {
      return adapter.claimRunTerminal({
        runId,
        fromStatuses: NON_TERMINAL_RUN_STATUSES,
        updates,
      });
    }

    const current = await adapter.getRun(runId);
    if (
      !current ||
      !isNonTerminalRunStatus(coerceRunStatus(current["status"]))
    ) {
      return false;
    }

    await adapter.updateRun(runId, updates);
    return true;
  }

  async function reconcileRunWithWorkflowTerminalStatus(
    run: Record<string, unknown>,
    workflowStatus: unknown,
  ): Promise<Record<string, unknown>> {
    const terminalStatus = coerceWorkflowTerminalStatus(workflowStatus);
    const currentStatus = coerceRunStatus(run["status"]);
    if (!terminalStatus || !isNonTerminalRunStatus(currentStatus)) {
      return run;
    }

    const runId = getRunId(run);
    if (!runId) return run;

    const completedAt = new Date();
    const durationMs = getRunDurationMs(run, completedAt);
    const counters = getRunCountersFromRecord(run);
    const failed =
      terminalStatus === "failed" ? Math.max(counters.failed, 1) : undefined;
    const existingError =
      typeof run["error"] === "string" ? run["error"] : null;
    const error =
      terminalStatus === "completed"
        ? null
        : (existingError ??
          `Workflow reported ${terminalStatus} before khotan observed completion`);

    const updates: KhotanTerminalRunUpdate = {
      status: terminalStatus,
      completedAt,
      error,
    };
    if (durationMs !== null) updates.durationMs = durationMs;
    if (failed !== undefined) updates.failed = failed;

    const transitioned = await claimTerminalRun(runId, updates);
    if (!transitioned) {
      return (await adapter.getRun(runId)) ?? run;
    }

    const flowId = getRunFlowId(run);
    if (flowId) {
      await adapter.updateFlowLastRun(flowId, {
        lastRunAt: completedAt,
        lastRunStatus: terminalStatus,
      });
    }

    await emitFactoryFlowHook(await getFlowHookContextForRun(run), {
      id: runId,
      status: terminalStatus,
      variant: getRunVariant(run),
      source: coerceRunSource(run["source"]),
      durationMs: durationMs ?? 0,
      ...counters,
      ...(failed !== undefined ? { failed } : {}),
      error,
    });

    return {
      ...run,
      ...updates,
    };
  }

  async function reconcileRunRowsWithWorkflowStatus(
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (
      !rows.some(
        (run) =>
          isNonTerminalRunStatus(coerceRunStatus(run["status"])) &&
          !!getRunWorkflowId(run),
      )
    ) {
      return rows;
    }

    let getRun: Awaited<ReturnType<typeof importWorkflowGetRun>>;
    try {
      getRun = await importWorkflowGetRun();
    } catch {
      return rows;
    }

    return Promise.all(
      rows.map(async (run) => {
        if (
          !isNonTerminalRunStatus(coerceRunStatus(run["status"])) ||
          !getRunWorkflowId(run)
        ) {
          return run;
        }

        try {
          const workflowRun = getRun(getRunWorkflowId(run)!);
          const workflowStatus = workflowRun.status
            ? await workflowRun.status
            : null;
          const reconciledRun = await reconcileRunWithWorkflowTerminalStatus(
            run,
            workflowStatus,
          );
          return { ...reconciledRun, workflowStatus };
        } catch (error) {
          return {
            ...run,
            workflowStatus: null,
            workflowError: getErrorMessage(error),
          };
        }
      }),
    );
  }

  function isStuckCandidate(
    run: Record<string, unknown>,
    olderThan: Date,
    statuses: ("pending" | "running")[],
  ): boolean {
    const status = coerceRunStatus(run["status"]);
    const startedAt = coerceDate(run["startedAt"]);
    return (
      !!status &&
      statuses.includes(status as "pending" | "running") &&
      !!startedAt &&
      startedAt.getTime() <= olderThan.getTime()
    );
  }

  async function getStuckRunCandidates(params: {
    flowId?: string;
    olderThan: Date;
    statuses: ("pending" | "running")[];
    limit: number;
  }): Promise<Record<string, unknown>[]> {
    if (adapter.listStuckRuns) {
      return adapter.listStuckRuns({
        flowId: params.flowId ?? null,
        olderThan: params.olderThan,
        statuses: params.statuses,
        limit: params.limit,
      });
    }

    if (params.flowId) {
      return (await adapter.listRuns(params.flowId))
        .filter((run) =>
          isStuckCandidate(run, params.olderThan, params.statuses),
        )
        .slice(0, params.limit);
    }

    const candidates: Record<string, unknown>[] = [];
    const pageSize = 100;
    let offset = 0;
    let hasMore = true;
    while (hasMore && candidates.length < params.limit) {
      const page = await adapter.listRunsPage({ limit: pageSize, offset });
      for (const run of page.items) {
        if (isStuckCandidate(run, params.olderThan, params.statuses)) {
          candidates.push(run);
          if (candidates.length >= params.limit) break;
        }
      }
      hasMore = page.hasMore;
      offset += pageSize;
    }
    return candidates;
  }

  async function getFlowHookContextForRun(
    run: Record<string, unknown>,
  ): Promise<FlowHookContext | null> {
    const flowId = getRunFlowId(run);
    if (!flowId) return null;
    const flow = await adapter.getFlow(flowId);
    if (!flow) return null;
    const flowConfig = getRegisteredFlowConfig(flow);
    if (!flowConfig) return null;
    const plugName =
      typeof flow["plugName"] === "string" ? flow["plugName"] : null;
    if (!plugName) return null;
    const relayDestinationRefs = getRelayDestinationRefs(flowConfig.to);
    return {
      flow: {
        id: flowId,
        name: flowConfig.name,
        plugName,
        type: flowConfig.type,
        resource: flowConfig.resource ?? null,
        to: flowConfig.to ?? null,
        ...(relayDestinationRefs.length > 0
          ? { destinations: relayDestinationRefs }
          : {}),
      },
      variant:
        typeof run["variant"] === "string" ? run["variant"] : DEFAULT_VARIANT,
    };
  }

  async function emitFactoryFlowHook(
    ctx: FlowHookContext | null,
    summary: RunSummary,
  ): Promise<void> {
    if (!ctx) return;
    const hook =
      summary.status === "completed" ? onFlowRunComplete : onFlowRunFailed;
    if (!hook) return;
    try {
      await hook(ctx, summary);
    } catch (error) {
      kd("flow", `factory lifecycle hook for "${ctx.flow.name}" threw`, error);
    }
  }

  function getRunCountersFromRecord(run: Record<string, unknown>) {
    const numberOrZero = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0;
    return {
      extracted: numberOrZero(run["extracted"]),
      transformed: numberOrZero(run["transformed"]),
      created: numberOrZero(run["created"]),
      updated: numberOrZero(run["updated"]),
      deleted: numberOrZero(run["deleted"]),
      failed: numberOrZero(run["failed"]),
      skipped: numberOrZero(run["skipped"]),
    };
  }

  /**
   * Map an execution-engine status string onto a khotan run status.
   * `null` means the engine still considers the run in flight, so the row must
   * be left alone; `undefined` means the status was unrecognized.
   */
  function mapEngineStatus(
    engineStatus: string,
  ): KhotanReconciledRunStatus | null | undefined {
    switch (engineStatus.trim().toLowerCase()) {
      case "completed":
      case "complete":
      case "succeeded":
      case "success":
        return "completed";
      case "failed":
      case "failure":
      case "errored":
        return "failed";
      case "cancelled":
      case "canceled":
      case "aborted":
        return "cancelled";
      case "running":
      case "pending":
      case "queued":
      case "suspended":
      case "waiting":
        return null;
      default:
        return undefined;
    }
  }

  interface EngineOutcome {
    status: KhotanReconciledRunStatus | null;
    engineStatus: string | null;
    result: FlowRunResult | null;
  }

  /**
   * Ask the workflow engine what actually happened to a run. The run row is the
   * only place khotan records outcomes, and for workflow-backed flows it is
   * written by an observer bound to the triggering invocation — which dies long
   * before a long run finishes. The engine outlives that, so it is the source
   * of truth when reconciling.
   */
  async function getEngineOutcome(
    workflowRunId: string | null,
  ): Promise<EngineOutcome | null> {
    if (!workflowRunId) return null;

    let handle: ReturnType<Awaited<ReturnType<typeof importWorkflowGetRun>>>;
    try {
      const getRun = await importWorkflowGetRun();
      handle = getRun(workflowRunId);
    } catch (error) {
      kd("flow", `Engine lookup failed for workflow run ${workflowRunId}`, error);
      return null;
    }

    let engineStatus: string | null = null;
    try {
      engineStatus = handle.status ? await handle.status : null;
    } catch (error) {
      kd("flow", `Engine status unavailable for run ${workflowRunId}`, error);
      return null;
    }
    if (!engineStatus) return null;

    const mapped = mapEngineStatus(engineStatus);
    if (mapped === undefined) {
      kd("flow", `Unrecognized engine status "${engineStatus}"`);
      return null;
    }
    if (mapped === null) return { status: null, engineStatus, result: null };

    // Recover the counters the lost observer never got to write.
    let result: FlowRunResult | null = null;
    if (mapped === "completed") {
      try {
        result = handle.returnValue
          ? (toFlowRunResult(await handle.returnValue) ?? null)
          : null;
      } catch (error) {
        kd("flow", `Engine returnValue unavailable for ${workflowRunId}`, error);
      }
    }

    return { status: mapped, engineStatus, result };
  }

  async function reconcileStuckRuns(
    options: StuckRunReconcileOptions = {},
  ): Promise<StuckRunReconcileResult> {
    await init();

    const now = options.now ?? new Date();
    const olderThanMs = Math.max(options.olderThanMs ?? 30 * 60_000, 1);
    const olderThan = new Date(now.getTime() - olderThanMs);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const statuses = (
      options.statuses && options.statuses.length > 0
        ? options.statuses
        : ["pending", "running"]
    ).filter(
      (status): status is "pending" | "running" =>
        status === "pending" || status === "running",
    );
    const toStatus = options.status ?? "abandoned";
    const dryRun = options.dryRun ?? false;
    const reconcileFromEngine = options.reconcileFromEngine ?? true;
    const fallbackError =
      options.error ??
      `Marked ${toStatus} by khotan stuck-run reconciliation after ${String(
        olderThanMs,
      )}ms; the execution engine did not report a terminal status`;

    if (statuses.length === 0) {
      return {
        ok: true,
        dryRun,
        checked: 0,
        reconciled: 0,
        skipped: 0,
        inFlight: 0,
        olderThan: olderThan.toISOString(),
        items: [],
      };
    }

    const candidateOptions: {
      flowId?: string;
      olderThan: Date;
      statuses: ("pending" | "running")[];
      limit: number;
    } = {
      olderThan,
      statuses,
      limit,
    };
    if (options.flowId) candidateOptions.flowId = options.flowId;
    const candidates = await getStuckRunCandidates(candidateOptions);

    const items: StuckRunReconcileItem[] = [];
    let reconciled = 0;
    let skipped = 0;
    let inFlight = 0;

    for (const run of candidates) {
      const runId = getRunId(run);
      if (!runId) {
        skipped++;
        continue;
      }
      const previousStatus = coerceRunStatus(run["status"]);
      if (previousStatus !== "pending" && previousStatus !== "running") {
        skipped++;
        continue;
      }

      const startedAt = coerceDate(run["startedAt"]);
      const durationMs = startedAt ? now.getTime() - startedAt.getTime() : null;
      const flowId = getRunFlowId(run);
      const workflowRunId = getRunWorkflowId(run);

      // Prefer the engine's account of the run over inferring from age.
      const outcome = reconcileFromEngine
        ? await getEngineOutcome(workflowRunId)
        : null;

      // The engine says it is still running — a legitimately long run, not a
      // stuck row. Marking it terminal here would be the same lie in reverse.
      if (outcome?.status === null) {
        inFlight++;
        continue;
      }

      const resolvedStatus = outcome?.status ?? toStatus;
      const engineResult = outcome?.result ?? null;
      const error =
        outcome?.status != null
          ? (engineResult?.error ??
            `Recovered from execution engine (status: ${String(
              outcome.engineStatus,
            )})`)
          : fallbackError;

      const item: StuckRunReconcileItem = {
        id: runId,
        flowId,
        workflowRunId,
        variant:
          typeof run["variant"] === "string" ? run["variant"] : DEFAULT_VARIANT,
        source: coerceRunSource(run["source"]),
        previousStatus,
        status: resolvedStatus,
        startedAt,
        completedAt: now,
        durationMs,
        error,
        dryRun,
        reconciled: false,
        statusSource: outcome?.status != null ? "engine" : "timeout",
        engineStatus: outcome?.engineStatus ?? null,
      };

      if (dryRun) {
        items.push(item);
        continue;
      }

      const claimed = adapter.claimStuckRun
        ? await adapter.claimStuckRun({
            runId,
            olderThan,
            fromStatuses: statuses,
            toStatus: resolvedStatus,
            completedAt: now,
            durationMs,
            error,
          })
        : await (async () => {
            const current = await adapter.getRun(runId);
            if (!current || !isStuckCandidate(current, olderThan, statuses)) {
              return false;
            }
            await adapter.updateRun(runId, {
              status: resolvedStatus,
              completedAt: now,
              ...(durationMs !== null ? { durationMs } : {}),
              failed: resolvedStatus === "failed" ? 1 : 0,
              error,
            });
            return true;
          })();

      if (!claimed) {
        skipped++;
        items.push(item);
        continue;
      }

      // The run is claimed; now restore the counters the lost observer never
      // wrote. Only the engine can supply these, so this is skipped on timeout.
      const recoveredCounters = engineResult
        ? getFlowRunCounters(engineResult)
        : null;
      if (recoveredCounters) {
        await adapter.updateRun(runId, {
          status: resolvedStatus,
          ...recoveredCounters,
          ...(engineResult?.metadata ? { metadata: engineResult.metadata } : {}),
        });
      }

      item.reconciled = true;
      reconciled++;
      items.push(item);

      if (flowId) {
        await adapter.updateFlowLastRun(flowId, {
          lastRunAt: now,
          lastRunStatus: resolvedStatus,
        });
      }

      const counters = recoveredCounters ?? getRunCountersFromRecord(run);
      const hookContext = await getFlowHookContextForRun(run);
      await emitFactoryFlowHook(hookContext, {
        id: runId,
        status: resolvedStatus,
        variant: item.variant,
        source: item.source,
        durationMs: durationMs ?? 0,
        ...counters,
        failed: resolvedStatus === "failed" ? 1 : counters.failed,
        error,
      });
    }

    return {
      ok: true,
      dryRun,
      checked: candidates.length,
      reconciled,
      skipped,
      inFlight,
      olderThan: olderThan.toISOString(),
      items,
    };
  }

  function parseStuckRunReconcileBody(body: unknown): StuckRunReconcileOptions {
    if (!isPlainObject(body)) return {};
    const options: StuckRunReconcileOptions = {};
    if (typeof body["olderThanMs"] === "number") {
      options.olderThanMs = body["olderThanMs"];
    }
    if (typeof body["limit"] === "number") {
      options.limit = body["limit"];
    }
    if (
      body["status"] === "failed" ||
      body["status"] === "cancelled" ||
      body["status"] === "abandoned"
    ) {
      options.status = body["status"];
    }
    if (typeof body["error"] === "string") {
      options.error = body["error"];
    }
    if (typeof body["dryRun"] === "boolean") {
      options.dryRun = body["dryRun"];
    }
    if (typeof body["reconcileFromEngine"] === "boolean") {
      options.reconcileFromEngine = body["reconcileFromEngine"];
    }
    if (Array.isArray(body["statuses"])) {
      options.statuses = body["statuses"].filter(
        (status): status is "pending" | "running" =>
          status === "pending" || status === "running",
      );
    }
    return options;
  }

  // -------------------------------------------------------------------------
  // Webhook processing helper (de-duplicated catch/pass loop)
  // -------------------------------------------------------------------------

  function getHeaderValue(
    headers: Record<string, string>,
    headerName: string,
  ): string | null {
    const lowerName = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowerName) return value;
    }
    return null;
  }

  function getPathValue(
    source: Record<string, unknown>,
    path: string,
  ): unknown {
    const parts = path.split(".").filter(Boolean);
    let current: unknown = source;
    for (const part of parts) {
      if (!isPlainObject(current)) return undefined;
      current = current[part];
    }
    return current;
  }

  function normalizeIdempotencyValue(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return null;
  }

  async function resolveWebhookIdempotencyKey(
    handler: CatchRegistration | PassRegistration,
    ctx: {
      event: Record<string, unknown>;
      eventType: string;
      headers: Record<string, string>;
    },
  ): Promise<string | null> {
    const configured = handler.idempotencyKey;
    if (typeof configured === "function") {
      return normalizeIdempotencyValue(await configured(ctx));
    }

    if (typeof configured === "string" && configured.trim()) {
      const source = configured.trim();
      if (source.startsWith("header:")) {
        return normalizeIdempotencyValue(
          getHeaderValue(ctx.headers, source.slice("header:".length)),
        );
      }
      if (source.startsWith("headers.")) {
        return normalizeIdempotencyValue(
          getHeaderValue(ctx.headers, source.slice("headers.".length)),
        );
      }
      const eventPath = source.startsWith("event.")
        ? source.slice("event.".length)
        : source;
      return normalizeIdempotencyValue(getPathValue(ctx.event, eventPath));
    }

    const headerCandidates = [
      "idempotency-key",
      "x-idempotency-key",
      "x-event-id",
      "x-github-delivery",
      "x-shopify-webhook-id",
      "webhook-id",
    ];
    for (const header of headerCandidates) {
      const value = normalizeIdempotencyValue(
        getHeaderValue(ctx.headers, header),
      );
      if (value) return `${ctx.eventType}:${value}`;
    }

    for (const path of ["id", "eventId", "event_id", "data.id"]) {
      const value = normalizeIdempotencyValue(getPathValue(ctx.event, path));
      if (value) return `${ctx.eventType}:${value}`;
    }

    return null;
  }

  function getWebhookDuplicatePolicy(
    handler: CatchRegistration | PassRegistration,
  ): WebhookDuplicatePolicy {
    return handler.duplicatePolicy === "process" ? "process" : "ignore";
  }

  function getWebhookAttempts(row: Record<string, unknown> | null): number {
    const value = row?.["attempts"];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function webhookEventStatusFromRun(
    status: KhotanTerminalRunStatus,
  ): Extract<WebhookEventStatus, "processed" | "failed"> {
    return status === "failed" || status === "cancelled"
      ? "failed"
      : "processed";
  }

  async function processWebhookHandler(
    handler: CatchRegistration | PassRegistration,
    ctx: {
      event: Record<string, unknown>;
      eventType: string;
      headers: Record<string, string>;
      dbHandlers: Record<string, unknown>[];
      wireId: string | null;
      startWorkflow: Awaited<ReturnType<typeof importWorkflowStart>>;
      allPlugs: Record<string, unknown>[];
      plugName: string;
      forceProcess?: boolean;
      replayOfWebhookEventId?: string | null;
    },
  ): Promise<void> {
    const handlerRow = ctx.dbHandlers.find(
      (h) => h["name"] === handler.name && h["type"] === handler.type,
    );
    const handlerId = handlerRow ? (handlerRow["id"] as string) : null;
    if (!handlerId || !ctx.wireId) {
      return;
    }

    const idempotencyKey = await resolveWebhookIdempotencyKey(handler, ctx);
    const duplicatePolicy = getWebhookDuplicatePolicy(handler);
    const dedupeKey =
      !ctx.forceProcess && duplicatePolicy === "ignore" && idempotencyKey
        ? `${handler.type}:${handler.name}:${idempotencyKey}`
        : null;

    const recordWebhookEvent = async (status: WebhookEventStatus) =>
      adapter.insertWebhookEvent({
        wireId: ctx.wireId!,
        webhookHandlerId: handlerId,
        khotanRunId: null,
        eventType: ctx.eventType,
        payload: ctx.event,
        headers: ctx.headers,
        status,
        idempotencyKey,
        dedupeKey: status === "received" ? dedupeKey : null,
        duplicateOfWebhookEventId:
          status === "received" ? (ctx.replayOfWebhookEventId ?? null) : null,
        completedAt:
          status === "ignored" || status === "duplicate" ? new Date() : null,
        error:
          status === "ignored"
            ? "Webhook handler ignored this event"
            : status === "duplicate"
              ? "Duplicate webhook event"
              : null,
      });

    if (
      Array.isArray(handler.events) &&
      handler.events.length > 0 &&
      !handler.events.includes(ctx.eventType)
    ) {
      await recordWebhookEvent("ignored");
      return;
    }

    if (handlerRow?.["enabled"] === false) {
      await recordWebhookEvent("ignored");
      return;
    }

    const claimedEvent = await recordWebhookEvent("received");
    if (claimedEvent.duplicate) {
      return;
    }
    const webhookEventId = claimedEvent.id;

    let destVars: Record<string, string> = {};
    if (handler.type === "pass") {
      const destPlug = ctx.allPlugs.find((dp) => dp["name"] === handler.to);
      if (destPlug) {
        const destPlugId = destPlug["id"] as string;
        const encrypted = await adapter.getEncryptedVariables(destPlugId);
        if (encrypted && secret) {
          destVars = await readEncryptedJson(encrypted, secret, decryptVars);
        }
      }
    }

    await adapter.updateWebhookEvent(webhookEventId, {
      status: "queued",
      error: null,
    });

    const { id: khotanRunId } = await adapter.insertRun({
      webhookHandlerId: handlerId,
      wireId: ctx.wireId,
      workflowRunId: null,
      variant: "webhook",
      source: "webhook",
      status: "running",
      metadata: {
        webhookEventId,
        eventType: ctx.eventType,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    });
    const startedAt = Date.now();

    await adapter.updateWebhookEvent(webhookEventId, {
      khotanRunId,
      status: "processing",
      attempts:
        getWebhookAttempts(await adapter.getWebhookEvent(webhookEventId)) + 1,
      processingStartedAt: new Date(startedAt),
      completedAt: null,
      error: null,
    });

    let finalized = false;
    async function finalizeWebhookRun(
      result: FlowRunResult | undefined,
      thrownError?: unknown,
    ): Promise<void> {
      if (finalized) return;
      finalized = true;

      const completedAt = new Date();
      const durationMs = Date.now() - startedAt;
      const runResult = thrownError ? undefined : result;
      const counters = thrownError
        ? { ...getFlowRunCounters(undefined), failed: 1 }
        : getFlowRunCounters(runResult);
      const status: KhotanTerminalRunStatus = thrownError
        ? "failed"
        : resolveTerminalRunStatus(runResult, counters);
      const error = thrownError
        ? getErrorMessage(thrownError)
        : (runResult?.error ?? null);
      const metadata =
        runResult && "metadata" in runResult
          ? (runResult.metadata ?? null)
          : {
              webhookEventId,
              eventType: ctx.eventType,
              ...(idempotencyKey ? { idempotencyKey } : {}),
            };

      await claimTerminalRun(khotanRunId, {
        status,
        completedAt,
        durationMs,
        ...counters,
        error,
        metadata,
      });

      await adapter.updateWebhookEvent(webhookEventId, {
        khotanRunId,
        status: webhookEventStatusFromRun(status),
        completedAt,
        error,
      });
    }

    try {
      const eventForWorkflow =
        handler.type === "catch" && handler.schema
          ? handler.schema.parse(ctx.event)
          : ctx.event;
      const workflowCtx =
        handler.type === "pass"
          ? {
              event: ctx.event,
              eventType: ctx.eventType,
              headers: ctx.headers,
              destVars,
              webhookEventId,
              idempotencyKey,
              khotanRunId,
              khotanInstanceId: instanceId,
            }
          : {
              event: eventForWorkflow,
              eventType: ctx.eventType,
              headers: ctx.headers,
              webhookEventId,
              idempotencyKey,
              khotanRunId,
              khotanInstanceId: instanceId,
            };

      const result = await startWorkflowWithGuidance(
        ctx.startWorkflow,
        handler.workflow,
        [workflowCtx],
        {
          kind: "webhook",
          name: handler.name,
          plugName: ctx.plugName,
          routePath: `/api/khotan/webhook/${ctx.plugName}`,
        },
      );
      const workflowRunId = getWorkflowRunId(result);
      if (workflowRunId) {
        await adapter.updateRun(khotanRunId, {
          status: "running",
          workflowRunId,
        });
      }
      const returnValue = getWorkflowReturnValue(result);
      if (returnValue) {
        void returnValue
          .then(async (value) => {
            await finalizeWebhookRun(toFlowRunResult(value));
          })
          .catch(async (error: unknown) => {
            await finalizeWebhookRun(undefined, error);
          })
          .catch((error: unknown) => {
            kd(
              "webhook",
              `Failed to reconcile webhook run ${khotanRunId}`,
              error,
            );
          });
      }
    } catch (err) {
      await finalizeWebhookRun(undefined, err);
      throw err;
    }
  }

  function coerceWebhookEventStatusValue(
    value: unknown,
  ): WebhookEventStatus | null {
    return value === "received" ||
      value === "queued" ||
      value === "processing" ||
      value === "processed" ||
      value === "ignored" ||
      value === "failed" ||
      value === "duplicate"
      ? value
      : null;
  }

  function getRecordString(
    record: Record<string, unknown>,
    camelKey: string,
    snakeKey?: string,
  ): string | null {
    const value = record[camelKey] ?? (snakeKey ? record[snakeKey] : null);
    return typeof value === "string" ? value : null;
  }

  async function replayWebhookEvent(
    eventId: string,
    options: { olderThanMs?: number; allowProcessed?: boolean } = {},
  ): Promise<{ replayed: true }> {
    const event = await adapter.getWebhookEvent(eventId);
    if (!event) {
      throw new KhotanInternalNotFoundError(
        `Webhook event "${eventId}" not found`,
      );
    }

    const status = coerceWebhookEventStatusValue(event["status"]);
    if (status === "processing") {
      const olderThanMs = Math.max(options.olderThanMs ?? 30 * 60_000, 1);
      const processingStartedAt = coerceDate(event["processingStartedAt"]);
      const isAbandoned =
        !processingStartedAt ||
        Date.now() - processingStartedAt.getTime() >= olderThanMs;
      if (!isAbandoned) {
        throw new KhotanWireRequestError(
          `Webhook event "${eventId}" is still processing`,
        );
      }
      await adapter.updateWebhookEvent(eventId, {
        status: "failed",
        completedAt: new Date(),
        error: `Reclaimed abandoned processing claim before replay after ${String(olderThanMs)}ms`,
      });
    } else if (status === "processed" && !options.allowProcessed) {
      throw new KhotanWireRequestError(
        `Webhook event "${eventId}" is already processed; use replay to run it again`,
      );
    }

    const wireId = getRecordString(event, "wireId", "wire_id");
    const handlerId = getRecordString(
      event,
      "webhookHandlerId",
      "webhook_handler_id",
    );
    if (!wireId || !handlerId) {
      throw new KhotanWireRequestError(
        `Webhook event "${eventId}" cannot be replayed without wire and handler IDs`,
      );
    }

    const wireRecord = await adapter.getWire(wireId);
    const plugId = wireRecord
      ? getRecordString(wireRecord, "plugId", "plug_id")
      : null;
    const allPlugsRows = await adapter.listPlugs();
    const plugRow = plugId
      ? allPlugsRows.find((plug) => plug["id"] === plugId)
      : null;
    const plugName =
      plugRow && typeof plugRow["name"] === "string" ? plugRow["name"] : null;
    const plugReg = plugName
      ? (plugs.find((plug) => plug.name === plugName) ?? null)
      : null;
    if (!plugName || !plugReg) {
      throw new KhotanInternalNotFoundError(
        `Webhook event "${eventId}" references an unknown plug`,
      );
    }

    const dbHandlers = await adapter.listWebhookHandlers(wireId);
    const handlerRow = dbHandlers.find((row) => row["id"] === handlerId);
    const handlerName =
      handlerRow && typeof handlerRow["name"] === "string"
        ? handlerRow["name"]
        : null;
    const handlerType =
      handlerRow?.["type"] === "catch" || handlerRow?.["type"] === "pass"
        ? handlerRow["type"]
        : null;
    const handlerConfig = getWebhookHandlersForPlug(plugReg).find(
      (handler) => handler.name === handlerName && handler.type === handlerType,
    );
    if (!handlerConfig) {
      throw new KhotanInternalNotFoundError(
        `Webhook event "${eventId}" references an unregistered handler`,
      );
    }

    const payload = isPlainObject(event["payload"]) ? event["payload"] : {};
    const headers = isPlainObject(event["headers"])
      ? Object.fromEntries(
          Object.entries(event["headers"]).map(([key, value]) => [
            key,
            typeof value === "string" ? value : String(value),
          ]),
        )
      : {};
    const eventType =
      typeof event["eventType"] === "string" ? event["eventType"] : "unknown";
    const startWorkflow = await importWorkflowStart();

    await processWebhookHandler(handlerConfig, {
      event: payload,
      eventType,
      headers,
      dbHandlers,
      wireId,
      startWorkflow,
      allPlugs: allPlugsRows,
      plugName,
      forceProcess: true,
      replayOfWebhookEventId: eventId,
    });

    return { replayed: true };
  }

  // -------------------------------------------------------------------------
  // Declarative route table
  // -------------------------------------------------------------------------

  const routes: RouteDefinition[] = [
    // --- GET routes ---
    {
      method: "GET",
      pattern: "caches/:cacheName/:key",
      auth: "authorize",
      handler: async ({ params }) => {
        try {
          const entry = await readCacheEntry(
            params["cacheName"]!,
            params["key"]!,
          );
          if (!entry) {
            return Response.json(
              { error: "Cache entry not found" },
              { status: 404 },
            );
          }
          return Response.json({
            cache: params["cacheName"],
            key: entry.key,
            value: entry.value,
            expiresAt: entry.expiresAt,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid cache request";
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
    {
      method: "GET",
      pattern: "cron",
      auth: "cron",
      handler: async () => {
        const result = await dispatchScheduledFlows();
        return Response.json(result);
      },
    },
    {
      method: "GET",
      pattern: "debug",
      auth: "debug",
      handler: async () => {
        return Response.json({ enabled: true });
      },
    },
    {
      method: "GET",
      pattern: "debug/:plugName",
      auth: "debug",
      handler: async ({ params, searchParams }) => {
        const plugName = params["plugName"]!;
        const plugReg = plugs.find((p) => p.name === plugName);
        if (!plugReg) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const selectedProfile = getProfileSelection(
          plugName,
          selectionFromSearchParams(searchParams),
        );
        const selection = selectedProfile
          ? { profile: selectedProfile }
          : undefined;
        const fields = plugReg.vars ?? plugReg.plug.varFields ?? [];
        const hasConfigured = await hasVars(plugName, selection).catch(
          () => false,
        );
        const rawEndpoints =
          plugReg.plug.endpoints ?? plugReg.endpoints ?? null;

        let varValues: Record<string, string> = {};
        if (
          hasConfigured ||
          Object.keys(getDefaultVars(plugName, selection)).length > 0
        ) {
          try {
            const raw = await getVars(plugName, selection);
            varValues = Object.fromEntries(
              Object.entries(maskVars(plugName, raw)).filter(([key]) => {
                const field = fields.find((f) => f.key === key);
                return field && !field.hidden;
              }),
            );
          } catch {
            /* no secret configured */
          }
        }

        return Response.json({
          name: plugReg.name,
          baseUrl: plugReg.plug.baseUrl,
          authType: plugReg.plug.authType,
          endpoints: serializeEndpoints(rawEndpoints),
          vars: {
            fields: fields.filter((f) => !f.hidden),
            configured: hasConfigured,
            values: varValues,
            ...(selectedProfile ? { profile: selectedProfile } : {}),
            profiles: await getVarProfileSummaries(plugName),
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "variables/:plugName",
      auth: "authorize",
      handler: async ({ params, searchParams }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const selectedProfile = getProfileSelection(
          plugName,
          selectionFromSearchParams(searchParams),
        );
        const selection = selectedProfile
          ? { profile: selectedProfile }
          : undefined;
        const fields = getVarFields(plugName);
        const hasValues = await hasVars(plugName, selection);
        let masked: Record<string, string> = {};
        if (
          hasValues ||
          Object.keys(getDefaultVars(plugName, selection)).length > 0
        ) {
          try {
            const vars = await getVars(plugName, selection);
            masked = maskVars(plugName, vars);
          } catch {
            masked = {};
          }
        }
        return Response.json({
          fields,
          values: masked,
          configured: hasValues,
          ...(selectedProfile ? { profile: selectedProfile } : {}),
          profiles: await getVarProfileSummaries(plugName),
        });
      },
    },
    {
      method: "GET",
      pattern: "wires/:plugName",
      auth: "authorize",
      handler: async ({ params }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const plugReg = plugs.find((p) => p.name === plugName);
        if (!plugReg?.wires || plugReg.wires.length === 0) {
          return Response.json({ wire: null, configured: false });
        }
        const wireRecord = await wire(plugName).get();
        return Response.json({ wire: wireRecord, configured: true });
      },
    },
    {
      method: "GET",
      pattern: "webhook-handlers/:plugName",
      auth: "authorize",
      handler: async ({ params }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const allPlugsRows = await adapter.listPlugs();
        const dbPlug = allPlugsRows.find((p) => p["name"] === plugName);
        if (!dbPlug) {
          return Response.json([]);
        }
        const plugId = dbPlug["id"] as string;
        const wireRecord = await adapter.getPlugWire(plugId);
        if (!wireRecord) {
          return Response.json([]);
        }
        const wireId = wireRecord["id"] as string;
        const handlers = await adapter.listWebhookHandlers(wireId);
        const plugReg = plugs.find((p) => p.name === plugName);
        const configuredHandlerEvents = new Map<string, string[] | undefined>();
        for (const handler of plugReg
          ? getWebhookHandlersForPlug(plugReg)
          : []) {
          configuredHandlerEvents.set(
            `${handler.type}:${handler.name}`,
            handler.events,
          );
        }
        const handlersWithRuns = await Promise.all(
          handlers.map(async (handler) => {
            const handlerId = handler["id"];
            if (typeof handlerId !== "string") return handler;
            const latestRun =
              await adapter.getLatestWebhookHandlerRun(handlerId);
            return {
              ...handler,
              events:
                configuredHandlerEvents.get(
                  `${String(handler["type"])}:${String(handler["name"])}`,
                ) ?? null,
              lastRunStatus: latestRun?.["status"] ?? null,
              lastRunAt: latestRun?.["startedAt"] ?? null,
            };
          }),
        );
        return Response.json(handlersWithRuns);
      },
    },
    {
      method: "GET",
      pattern: "plugs",
      auth: "authorize",
      handler: async () => {
        const data = await adapter.listPlugs();
        const filtered = data.filter(
          (p) => typeof p["name"] === "string" && plugNames.has(p["name"]),
        );
        const registeredFlows = await listRegisteredFlowRecords(data);
        const withVarState = await Promise.all(
          filtered.map(async (plug) => {
            const pName = plug["name"] as string;
            let varsConfigured = false;
            try {
              varsConfigured = await hasVars(pName);
            } catch {
              varsConfigured = false;
            }
            return {
              ...plug,
              flowCount:
                typeof plug["id"] === "string"
                  ? countAssociatedFlows(registeredFlows, plug["id"])
                  : plug["flowCount"],
              varsConfigured,
            };
          }),
        );
        return Response.json(withVarState);
      },
    },
    {
      method: "GET",
      pattern: "plugs/:plugId",
      auth: "authorize",
      handler: async ({ params }) => {
        const plugId = params["plugId"]!;
        const plug = await adapter.getPlug(plugId);
        if (
          !plug ||
          typeof plug["name"] !== "string" ||
          !plugNames.has(plug["name"])
        ) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const flows = (await listRegisteredFlowRecords()).filter((flow) =>
          isFlowAssociatedWithPlug(flow, plugId),
        );
        return Response.json({ ...plug, flows });
      },
    },
    {
      method: "GET",
      pattern: "flows",
      auth: "authorize",
      handler: async () => {
        return Response.json(await listRegisteredFlowRecords());
      },
    },
    {
      method: "GET",
      pattern: "flows/:flowId/runs",
      auth: "authorize",
      handler: async ({ params }) => {
        const flowId = params["flowId"]!;
        const data = await reconcileRunRowsWithWorkflowStatus(
          await adapter.listRuns(flowId),
        );
        return Response.json(data);
      },
    },
    {
      method: "GET",
      pattern: "runs",
      auth: "authorize",
      handler: async ({ url }) => {
        const limit = Math.min(
          Math.max(
            Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
            1,
          ),
          100,
        );
        const offset = Math.max(
          Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
          0,
        );
        const page = await adapter.listRunsPage({ limit, offset });
        const items = await reconcileRunRowsWithWorkflowStatus(page.items);
        return Response.json({
          items: items.map(addRunOperationalLinks),
          page: {
            limit,
            offset,
            hasMore: page.hasMore,
            prevOffset: Math.max(offset - limit, 0),
            nextOffset: offset + limit,
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "runs/:runId/stream",
      auth: "authorize",
      handler: async ({ params, url }) => {
        const runId = params["runId"]!;
        const run = await adapter.getRun(runId);
        if (!run) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }

        const startIndexParam = url.searchParams.get("startIndex");
        const parsedStartIndex =
          startIndexParam == null ? null : Number.parseInt(startIndexParam, 10);
        const namespace = url.searchParams.get("namespace") ?? undefined;
        const persistedUpdates =
          adapter.listRunUpdates === undefined
            ? []
            : await adapter
                .listRunUpdates({
                  runId,
                  ...(typeof parsedStartIndex === "number" &&
                  Number.isFinite(parsedStartIndex)
                    ? { startIndex: parsedStartIndex }
                    : {}),
                  ...(namespace ? { namespace } : {}),
                })
                .catch((error: unknown) => {
                  kd(
                    "flow",
                    `Failed to load persisted run updates for ${runId}`,
                    error,
                  );
                  return [];
                });

        if (
          persistedUpdates.length > 0 &&
          isTerminalRunStatus(coerceRunStatus(run["status"]))
        ) {
          return new Response(streamFromRunUpdates(persistedUpdates), {
            headers: {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
            },
          });
        }

        const workflowRunId = getRunWorkflowId(run);
        if (!workflowRunId) {
          if (persistedUpdates.length > 0) {
            return new Response(streamFromRunUpdates(persistedUpdates), {
              headers: {
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
              },
            });
          }
          return Response.json(
            { error: "Run does not have a Workflow run ID" },
            { status: 400 },
          );
        }

        const getRun = await importWorkflowGetRun();
        const workflowRun = getRun(workflowRunId);
        const streamOptions: { startIndex?: number; namespace?: string } = {};
        if (
          typeof parsedStartIndex === "number" &&
          Number.isFinite(parsedStartIndex)
        ) {
          streamOptions.startIndex = parsedStartIndex;
        }
        if (namespace) streamOptions.namespace = namespace;
        const stream = workflowRun.getReadable?.(streamOptions);

        if (!stream) {
          if (persistedUpdates.length > 0) {
            return new Response(streamFromRunUpdates(persistedUpdates), {
              headers: {
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
              },
            });
          }
          return Response.json(
            { error: "Workflow run does not expose a readable stream" },
            { status: 400 },
          );
        }

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "runs/:runId",
      auth: "authorize",
      handler: async ({ params }) => {
        const runId = params["runId"]!;
        const run = await getRunWithWorkflowStatus(runId);
        if (!run) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }
        return Response.json(run);
      },
    },
    {
      method: "GET",
      pattern: "webhook-events",
      auth: "authorize",
      handler: async ({ url }) => {
        const limit = Math.min(
          Math.max(
            Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
            1,
          ),
          100,
        );
        const offset = Math.max(
          Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
          0,
        );
        const page = await adapter.listWebhookEventsPage({ limit, offset });
        return Response.json({
          items: page.items.map((item) => {
            const workflowRunId =
              typeof item["workflowRunId"] === "string"
                ? item["workflowRunId"]
                : null;
            return {
              ...item,
              vercelDeploymentUrl,
              vercelWorkflowRunUrl: getVercelWorkflowRunUrl(workflowRunId),
            };
          }),
          page: {
            limit,
            offset,
            hasMore: page.hasMore,
            prevOffset: Math.max(offset - limit, 0),
            nextOffset: offset + limit,
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "resources",
      auth: "authorize",
      handler: async () => {
        const data = await adapter.listResources();
        const filtered = data.filter(
          (r) => typeof r["name"] === "string" && resourceNames.has(r["name"]),
        );
        return Response.json(filtered.map(decorateResourceRecord));
      },
    },
    {
      method: "GET",
      pattern: "resources/:resourceId/mappings",
      auth: "authorize",
      handler: async ({ params, url }) => {
        const resourceId = params["resourceId"]!;
        const resource = await getRegisteredResourceById(resourceId);
        if (!resource) {
          return Response.json(
            { error: "Resource not found" },
            { status: 404 },
          );
        }

        const limit = Math.min(
          Math.max(
            Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
            1,
          ),
          100,
        );
        const offset = Math.max(
          Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
          0,
        );
        const trimmedSearch = url.searchParams.get("search")?.trim();
        const search =
          trimmedSearch !== undefined && trimmedSearch !== ""
            ? trimmedSearch
            : undefined;
        const wantsMappingPage =
          url.searchParams.has("limit") ||
          url.searchParams.has("offset") ||
          url.searchParams.has("search");

        const page = await listMappings({
          resourceId,
          limit,
          offset,
          ...(search ? { search } : {}),
        });

        if (!wantsMappingPage) {
          return Response.json(page.items);
        }

        return Response.json(page);
      },
    },
    {
      method: "GET",
      pattern: "resources/:resourceId",
      auth: "authorize",
      handler: async ({ params }) => {
        const resourceId = params["resourceId"]!;
        const resource = await adapter.getResource(resourceId);
        if (
          !resource ||
          typeof resource["name"] !== "string" ||
          !resourceNames.has(resource["name"])
        ) {
          return Response.json(
            { error: "Resource not found" },
            { status: 404 },
          );
        }
        const flows = await adapter.getResourceFlows(resourceId);
        return Response.json({ ...decorateResourceRecord(resource), flows });
      },
    },
    {
      method: "GET",
      pattern: "mappings/:mappingId",
      auth: "authorize",
      handler: async ({ params }) => {
        const mappingId = params["mappingId"]!;
        const mapping = await adapter.getMapping(mappingId);
        if (!mapping) {
          return Response.json({ error: "Mapping not found" }, { status: 404 });
        }
        return Response.json(mapping);
      },
    },

    // --- POST routes ---
    {
      method: "POST",
      pattern: "caches/:cacheName/:key",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const cacheName = params["cacheName"]!;
        const key = params["key"]!;
        const body = (await request.json().catch(() => ({}))) as {
          value?: unknown;
        };

        if (!("value" in body)) {
          return Response.json(
            { error: "Cache writes require a value" },
            { status: 400 },
          );
        }

        try {
          const cacheHandle = createCacheInstance(cacheName);
          await cacheHandle.set(key, body.value);
          const entry = await readCacheEntry(cacheName, key);
          return Response.json({
            cache: cacheName,
            key,
            value: body.value,
            expiresAt: entry?.expiresAt ?? null,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid cache payload";
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
    {
      method: "POST",
      pattern: "cron",
      auth: "cron",
      handler: async () => {
        const result = await dispatchScheduledFlows();
        return Response.json(result);
      },
    },
    {
      method: "POST",
      pattern: "webhook/:plugName",
      auth: "webhook",
      handler: async ({ params, request }) => {
        const plugName = params["plugName"]!;
        const plugReg = plugs.find((p) => p.name === plugName);
        if (!plugReg) {
          return Response.json(
            { error: `Unknown plug: ${plugName}` },
            { status: 404 },
          );
        }

        const wireConfig = plugReg.wires?.[0];
        if (!wireConfig?.onVerify) {
          return Response.json(
            { error: `No active wire for plug: ${plugName}` },
            { status: 404 },
          );
        }

        const rawBody = await request.text();

        const allPlugsRows = await adapter.listPlugs();
        const dbPlug = allPlugsRows.find((p) => p["name"] === plugName);
        if (!dbPlug) {
          return Response.json(
            { error: `Plug "${plugName}" not found in database` },
            { status: 404 },
          );
        }
        const plugId = dbPlug["id"] as string;
        const wireRecord = await adapter.getPlugWire(plugId);
        const wireId = wireRecord ? (wireRecord["id"] as string) : null;

        let wireVars: Record<string, string> = {};
        if (wireId) {
          const raw = await adapter.getWireMetadata(wireId);
          wireVars = await readEncryptedJson(raw, secret, decryptVars);
        }

        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const verified = await wireConfig.onVerify({
          headers,
          body: rawBody,
          wireVars,
        });
        if (!verified) {
          return Response.json(
            { error: "Webhook verification failed" },
            { status: 401 },
          );
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          event = {};
        }
        const eventType =
          typeof event["type"] === "string" ? event["type"] : "unknown";

        if (onWebhookReceived) {
          try {
            await onWebhookReceived({
              plug: {
                id: plugId,
                name: plugName,
              },
              wireId,
              eventType,
              event,
              headers,
              receivedAt: new Date(),
              rawBody,
            });
          } catch (err) {
            kd("webhook", `${plugName}: onWebhookReceived hook threw`, err);
          }
        }

        const webhookHandlers = getWebhookHandlersForPlug(plugReg);

        const processingWork = (async () => {
          try {
            const startWorkflow = await importWorkflowStart();
            const dbHandlers = wireId
              ? await adapter.listWebhookHandlers(wireId)
              : [];

            for (const handler of webhookHandlers) {
              await processWebhookHandler(handler, {
                event,
                eventType,
                headers,
                dbHandlers,
                wireId,
                startWorkflow,
                allPlugs: allPlugsRows,
                plugName,
              });
            }
          } catch (err) {
            kd("webhook", `${plugName}: workflow start failed:`, err);
          }
        })();

        getWaitUntil()(processingWork);

        return Response.json({ received: true }, { status: 202 });
      },
    },
    {
      method: "POST",
      pattern: "webhook-events/:eventId/retry",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          olderThanMs?: number;
        };
        try {
          const options: { olderThanMs?: number; allowProcessed?: boolean } = {
            allowProcessed: false,
          };
          if (typeof body.olderThanMs === "number") {
            options.olderThanMs = body.olderThanMs;
          }
          const result = await replayWebhookEvent(params["eventId"]!, options);
          return Response.json(result, { status: 202 });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          const status =
            error instanceof KhotanInternalNotFoundError
              ? 404
              : error instanceof KhotanWireRequestError
                ? 409
                : 500;
          return Response.json({ error: message }, { status });
        }
      },
    },
    {
      method: "POST",
      pattern: "webhook-events/:eventId/replay",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          olderThanMs?: number;
        };
        try {
          const options: { olderThanMs?: number; allowProcessed?: boolean } = {
            allowProcessed: true,
          };
          if (typeof body.olderThanMs === "number") {
            options.olderThanMs = body.olderThanMs;
          }
          const result = await replayWebhookEvent(params["eventId"]!, options);
          return Response.json(result, { status: 202 });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          const status =
            error instanceof KhotanInternalNotFoundError
              ? 404
              : error instanceof KhotanWireRequestError
                ? 409
                : 500;
          return Response.json({ error: message }, { status });
        }
      },
    },
    {
      method: "POST",
      pattern: "debug/:plugName",
      auth: "debug",
      handler: async ({ params, request, searchParams }) => {
        const plugName = params["plugName"]!;
        const plugReg = plugs.find((p) => p.name === plugName);
        if (!plugReg) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }

        const body = (await request.json()) as {
          method?: string;
          path?: string;
          body?: unknown;
          params?: Record<string, string>;
          headers?: Record<string, string>;
          profile?: string;
          target?: string;
        };

        const method = (body.method ?? "GET").toUpperCase();
        const reqPath = body.path ?? "/";
        const selectedProfile = getProfileSelection(
          plugName,
          selectionForProfile(
            normalizeProfileName(body.profile) ??
              normalizeProfileName(body.target) ??
              selectionFromSearchParams(searchParams)?.profile,
          ),
        );
        const selection = selectedProfile
          ? { profile: selectedProfile }
          : undefined;
        const start = Date.now();

        try {
          const plug = plugReg.plug;
          const vars = secret
            ? await getVars(plugName, selection).catch(() => ({}))
            : {};
          const _setVars = secret
            ? async (updates: Record<string, string>) => {
                Object.assign(vars, updates);
                await setVars(plugName, { ...vars }, selection);
              }
            : undefined;
          const opts: {
            params?: Record<string, unknown>;
            headers?: Record<string, string>;
            vars?: Record<string, string>;
            body?: unknown;
            _setVars?: (updates: Record<string, string>) => Promise<void>;
            plugName?: string;
            profile?: string;
            target?: string;
            _skipHooks?: boolean;
          } = { vars, plugName };
          if (_setVars) opts._setVars = _setVars;
          if (selectedProfile) {
            opts.profile = selectedProfile;
            opts.target = selectedProfile;
          }
          if (body.params) opts.params = body.params;
          if (body.headers) opts.headers = body.headers;
          if (body.body) opts.body = body.body;

          let result: unknown;
          switch (method) {
            case "GET":
              result = await plug.get(reqPath, opts);
              break;
            case "POST":
              result = await plug.post(reqPath, opts);
              break;
            case "PUT":
              result = await plug.put(reqPath, opts);
              break;
            case "PATCH":
              result = await plug.patch(reqPath, opts);
              break;
            case "DELETE":
              result = await plug.delete(reqPath, opts);
              break;
            default:
              result = await plug.get(reqPath, opts);
          }

          const timing = Date.now() - start;

          const response: Record<string, unknown> = {
            status: 200,
            statusText: "OK",
            headers: {},
            body: result,
            timing,
          };
          if (selectedProfile) {
            response["profile"] = selectedProfile;
          }

          const allEndpoints:
            | Record<string, { method: string; path: string }>
            | undefined = plugReg.plug.endpoints ?? plugReg.endpoints;
          if (allEndpoints) {
            const matched = Object.entries(allEndpoints).find(
              ([, ep]) =>
                ep.method.toUpperCase() === method && ep.path === reqPath,
            );
            if (matched) {
              response["endpoint"] = {
                name: matched[0],
                method: matched[1].method,
                path: matched[1].path,
              };
            }
          }

          return Response.json(response);
        } catch (err) {
          const timing = Date.now() - start;
          const error = err instanceof Error ? err.message : "Unknown error";
          const errBody =
            err && typeof err === "object" && "body" in err ? err.body : null;
          const errStatus =
            err && typeof err === "object" && "status" in err
              ? (err as { status: number }).status
              : 500;

          return Response.json({
            status: errStatus,
            statusText: "Error",
            headers: {},
            body: errBody,
            timing,
            error,
          });
        }
      },
    },
    {
      method: "POST",
      pattern: "variables/:plugName",
      auth: "authorize",
      handler: async ({ params, request, searchParams }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const selectedProfile = getProfileSelection(
          plugName,
          selectionFromSearchParams(searchParams),
        );
        const selection = selectedProfile
          ? { profile: selectedProfile }
          : undefined;
        const body = (await request.json()) as Record<string, string>;
        const fields = getVarFields(plugName);
        const merged = {
          ...(await getVars(plugName, selection).catch(() => ({}))),
        };

        for (const field of fields) {
          const value = body[field.key];
          if (value !== undefined) {
            merged[field.key] = value;
          }
        }

        const missing = fields
          .filter((f) => f.required !== false && !merged[f.key])
          .map((f) => f.key);
        if (missing.length > 0) {
          return Response.json(
            { error: `Missing required fields: ${missing.join(", ")}` },
            { status: 400 },
          );
        }

        const vars: Record<string, string> = {};
        for (const field of fields) {
          const value = merged[field.key];
          if (value !== undefined) {
            vars[field.key] = value;
          }
        }

        try {
          await setVars(plugName, vars, selection);
          return Response.json({
            ok: true,
            ...(selectedProfile ? { profile: selectedProfile } : {}),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      pattern: "runs/:runId/cancel",
      auth: "authorize",
      handler: async ({ params }) => {
        const runId = params["runId"]!;
        const run = await adapter.getRun(runId);
        if (!run) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }
        const workflowRunId = getRunWorkflowId(run);
        if (!workflowRunId) {
          return Response.json(
            { error: "Run does not have a Workflow run ID" },
            { status: 400 },
          );
        }

        const currentStatus = coerceRunStatus(run["status"]);
        if (currentStatus && !isNonTerminalRunStatus(currentStatus)) {
          const currentError =
            typeof run["error"] === "string" ? run["error"] : null;
          return Response.json({
            ok: true,
            id: runId,
            workflowRunId,
            status: currentStatus,
            ...(currentError !== null ? { error: currentError } : {}),
          });
        }

        const getRun = await importWorkflowGetRun();
        const workflowRun = getRun(workflowRunId);
        await workflowRun.cancel?.();

        const completedAt = new Date();
        const transitioned = await claimTerminalRun(runId, {
          status: "cancelled",
          completedAt,
          error: "Cancelled",
        });
        const flowId = typeof run["flowId"] === "string" ? run["flowId"] : null;
        if (transitioned && flowId) {
          await adapter.updateFlowLastRun(flowId, {
            lastRunAt: completedAt,
            lastRunStatus: "cancelled",
          });
        }
        if (transitioned) {
          const startedAt = coerceDate(run["startedAt"]);
          await emitFactoryFlowHook(await getFlowHookContextForRun(run), {
            id: runId,
            status: "cancelled",
            variant:
              typeof run["variant"] === "string"
                ? run["variant"]
                : DEFAULT_VARIANT,
            source: coerceRunSource(run["source"]),
            durationMs: startedAt
              ? Math.max(completedAt.getTime() - startedAt.getTime(), 0)
              : 0,
            ...getRunCountersFromRecord(run),
            error: "Cancelled",
          });
        }

        const latestRun = transitioned ? null : await adapter.getRun(runId);
        const responseRun = latestRun ?? run;
        const responseStatus = transitioned
          ? "cancelled"
          : (coerceRunStatus(responseRun["status"]) ?? "cancelled");
        const responseError = transitioned
          ? "Cancelled"
          : typeof responseRun["error"] === "string"
            ? responseRun["error"]
            : null;

        return Response.json({
          ok: true,
          id: runId,
          workflowRunId,
          status: responseStatus,
          ...(responseError !== null ? { error: responseError } : {}),
        });
      },
    },
    {
      method: "POST",
      pattern: "runs/:runId/retry",
      auth: "authorize",
      handler: async ({ params }) => {
        const runId = params["runId"]!;
        const run = await adapter.getRun(runId);
        if (!run) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }
        const flowId = typeof run["flowId"] === "string" ? run["flowId"] : null;
        if (!flowId) {
          return Response.json(
            { error: "Only flow runs can be retried from the Hub" },
            { status: 400 },
          );
        }
        const variant =
          typeof run["variant"] === "string" ? run["variant"] : DEFAULT_VARIANT;
        return triggerFlowRun(flowId, { variant }, "manual");
      },
    },
    {
      method: "POST",
      pattern: "runs/reconcile-stuck",
      auth: "authorize",
      handler: async ({ request }) => {
        const body: unknown = await request.json().catch(() => ({}));
        return Response.json(
          await reconcileStuckRuns(parseStuckRunReconcileBody(body)),
        );
      },
    },
    {
      method: "POST",
      pattern: "flows/:flowId/runs/reconcile-stuck",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const body: unknown = await request.json().catch(() => ({}));
        const flowId = params["flowId"]!;
        const flow = await adapter.getFlow(flowId);
        if (
          !flow ||
          typeof flow["plugName"] !== "string" ||
          !plugNames.has(flow["plugName"])
        ) {
          return Response.json({ error: "Flow not found" }, { status: 404 });
        }
        return Response.json(
          await reconcileStuckRuns({
            ...parseStuckRunReconcileBody(body),
            flowId,
          }),
        );
      },
    },
    {
      method: "POST",
      pattern: "flows/:flowId/runs",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const flowId = params["flowId"]!;
        const body: unknown = await request.json().catch(() => ({}));
        return triggerFlowRun(flowId, body, "manual");
      },
    },
    {
      method: "POST",
      pattern: "wires/:plugName/renew",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const body = (await request.json().catch(() => ({}))) as {
          wireId?: string;
        };
        try {
          const record = await wire(plugName).renew(body.wireId);
          return Response.json({ wire: record });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          kd("wire", `${plugName}: renew failed:`, message);
          const status =
            error instanceof KhotanInternalNotFoundError
              ? 404
              : error instanceof KhotanWireRequestError
                ? 400
                : 500;
          return Response.json({ error: message }, { status });
        }
      },
    },
    {
      method: "POST",
      pattern: "wires/:plugName",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const body = (await request.json()) as { callbackUrl: string };
        if (!body.callbackUrl) {
          return Response.json(
            { error: "callbackUrl is required" },
            { status: 400 },
          );
        }
        try {
          const record = await wire(plugName).create(body.callbackUrl);
          return Response.json({ wire: record }, { status: 201 });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          kd("wire", `${plugName}: create failed:`, message);
          if (error && typeof error === "object" && "body" in error) {
            kd("wire", `${plugName}: response body:`, error.body);
          }
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      pattern: "mappings/lookup",
      auth: "authorize",
      handler: async ({ request }) => {
        const body = (await request.json()) as
          | { resourceId: string; connectValue: string | string[] }
          | { resourceId: string; plugName: string; ref: string }
          | null;
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.resourceId !== "string"
        ) {
          return Response.json(
            {
              error:
                "Lookup requires resourceId plus either connectValue or plugName with ref",
            },
            { status: 400 },
          );
        }

        const hasConnectValue = "connectValue" in body;
        const hasPlugRef =
          "plugName" in body &&
          typeof body.plugName === "string" &&
          "ref" in body &&
          typeof body.ref === "string";

        if (!hasConnectValue && !hasPlugRef) {
          return Response.json(
            {
              error: "Lookup requires either connectValue or plugName with ref",
            },
            { status: 400 },
          );
        }

        let mapping: Record<string, unknown> | null;
        try {
          mapping = hasConnectValue
            ? await lookupMapping({
                resourceId: body.resourceId,
                connectValue: body.connectValue,
              })
            : await lookupMapping({
                resourceId: body.resourceId,
                plugName: body.plugName,
                ref: body.ref,
              });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid lookup request";
          return Response.json({ error: message }, { status: 400 });
        }

        if (!mapping) {
          return Response.json({ error: "Mapping not found" }, { status: 404 });
        }
        return Response.json(mapping);
      },
    },
    {
      method: "POST",
      pattern: "mappings",
      auth: "authorize",
      handler: async ({ request }) => {
        const body = (await request.json()) as {
          resourceId: string;
          connectValue: string | string[];
          refs: Record<string, string>;
          metadata?: Record<string, unknown> | null;
        };
        try {
          const existing = await lookupMapping({
            resourceId: body.resourceId,
            connectValue: body.connectValue,
          });
          const saved = await upsertMapping(body);
          return Response.json(saved, { status: existing ? 200 : 201 });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid mapping payload";
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },

    // --- PATCH routes ---
    {
      method: "PATCH",
      pattern: "plugs/:plugId",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const plugId = params["plugId"]!;
        const plug = await adapter.getPlug(plugId);
        if (
          !plug ||
          typeof plug["name"] !== "string" ||
          !plugNames.has(plug["name"])
        ) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const body = (await request.json()) as { enabled?: boolean };
        if (typeof body.enabled === "boolean") {
          await adapter.togglePlugEnabled(plugId, body.enabled);
        }
        const updated = await adapter.getPlug(plugId);
        return Response.json(updated);
      },
    },
    {
      method: "PATCH",
      pattern: "flows/:flowId",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const flowId = params["flowId"]!;
        const body = (await request.json()) as { enabled?: boolean };
        if (typeof body.enabled === "boolean") {
          await adapter.toggleFlowEnabled(flowId, body.enabled);
        }
        return Response.json({ id: flowId, ...body });
      },
    },
    {
      method: "PATCH",
      pattern: "webhook-handlers/:handlerId",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const handlerId = params["handlerId"]!;
        const body = (await request.json()) as { enabled?: boolean };
        if (typeof body.enabled === "boolean") {
          await adapter.toggleWebhookHandlerEnabled(handlerId, body.enabled);
        }
        return Response.json({ id: handlerId, ...body });
      },
    },

    // --- PUT routes ---
    {
      method: "PUT",
      pattern: "mappings/:mappingId",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const mappingId = params["mappingId"]!;
        const body = (await request.json()) as {
          resourceId: string;
          connectValue: string | string[];
          refs: Record<string, string>;
          metadata?: Record<string, unknown> | null;
        };
        try {
          const saved = await updateMapping(mappingId, body);
          return Response.json(saved);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid mapping payload";
          return Response.json(
            { error: message },
            { status: message.includes("not found") ? 404 : 400 },
          );
        }
      },
    },

    // --- DELETE routes ---
    {
      method: "DELETE",
      pattern: "caches/:cacheName/:key",
      auth: "authorize",
      handler: async ({ params }) => {
        try {
          await createCacheInstance(params["cacheName"]!).delete(
            params["key"]!,
          );
          return new Response(null, { status: 204 });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid cache request";
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
    {
      method: "DELETE",
      pattern: "variables/:plugName",
      auth: "authorize",
      handler: async ({ params, searchParams }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const selectedProfile = getProfileSelection(
          plugName,
          selectionFromSearchParams(searchParams),
        );
        await clearVars(
          plugName,
          selectedProfile ? { profile: selectedProfile } : undefined,
        );
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "DELETE",
      pattern: "wires/:plugName",
      auth: "authorize",
      handler: async ({ params, request }) => {
        const plugName = params["plugName"]!;
        if (!plugNames.has(plugName)) {
          return Response.json({ error: "Plug not found" }, { status: 404 });
        }
        const body = (await request.json()) as { wireId: string };
        if (!body.wireId) {
          return Response.json(
            { error: "wireId is required" },
            { status: 400 },
          );
        }
        try {
          await wire(plugName).delete(body.wireId);
          return new Response(null, { status: 204 });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          kd("wire", `${plugName}: delete failed: ${message}`);
          return Response.json(
            { error: message },
            {
              status: error instanceof KhotanInternalNotFoundError ? 404 : 500,
            },
          );
        }
      },
    },
    {
      method: "DELETE",
      pattern: "mappings/:mappingId",
      auth: "authorize",
      handler: async ({ params }) => {
        const mappingId = params["mappingId"]!;
        const existing = await adapter.getMapping(mappingId);
        if (!existing) {
          return Response.json({ error: "Mapping not found" }, { status: 404 });
        }
        await adapter.deleteMapping(mappingId);
        return new Response(null, { status: 204 });
      },
    },
  ];

  // -------------------------------------------------------------------------
  // Request handler — matches against the route table
  // -------------------------------------------------------------------------

  async function handler(request: Request): Promise<Response> {
    await init();

    const url = new URL(request.url);
    const fullSegments = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);

    // Strip the base prefix (everything before the khotan-managed segment).
    // The route patterns start from the first khotan-managed keyword.
    // Find where khotan routes begin by looking for a known first-segment keyword.
    const knownFirstSegments = new Set([
      "plugs",
      "flows",
      "resources",
      "caches",
      "mappings",
      "runs",
      "wires",
      "webhook-handlers",
      "webhook-events",
      "variables",
      "cron",
      "webhook",
      "debug",
    ]);

    let routeStartIdx = -1;
    for (let i = 0; i < fullSegments.length; i++) {
      if (knownFirstSegments.has(fullSegments[i]!)) {
        routeStartIdx = i;
        break;
      }
    }

    if (routeStartIdx === -1) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const pathSegments = fullSegments.slice(routeStartIdx);
    const match = matchRoute(request.method, pathSegments, routes);

    if (!match) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Auth gate
    const { route, params } = match;
    switch (route.auth) {
      case "cron":
        if (!isCronRequestAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        break;

      case "debug":
        if (!isDebugEnabled()) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        break;

      case "webhook":
        // Webhooks self-verify via onVerify — no management auth needed
        break;

      case "authorize":
        {
          let allowed = await isCliRequestAuthorized(request, secret);
          if (!allowed && authorizeHook) {
            try {
              allowed = await authorizeHook(request);
            } catch {
              allowed = false;
            }
          }
          if (!allowed && authorize === false) {
            allowed = true;
          }
          if (!allowed) {
            return Response.json(
              {
                error: "Unauthorized",
                code: "authorize_rejected",
                hint:
                  "Management routes (/api/khotan/*) require your `authorize` hook to pass. " +
                  "KHOTAN_SECRET is an encryption key, not an HTTP credential — sending it as a " +
                  "Bearer token will not authenticate the request. To trigger a flow: call " +
                  "khotanData.flow(name).start() from server code (no HTTP/auth needed), or send a " +
                  "credential your authorize hook accepts (e.g. a session cookie or your own token). " +
                  "The khotan CLI authenticates automatically via a dev-only token derived from KHOTAN_SECRET.",
              },
              { status: 401 },
            );
          }
        }
        break;

      case "none":
        break;
    }

    return route.handler({
      request,
      params,
      url,
      searchParams: url.searchParams,
    });
  }

  async function appendRunUpdate(
    update: KhotanPersistedRunUpdateInput,
  ): Promise<{ index: number | null }> {
    await init();
    if (!adapter.appendRunUpdate) return { index: null };
    return adapter.appendRunUpdate(update);
  }

  // -------------------------------------------------------------------------
  // Runtime registry
  // -------------------------------------------------------------------------

  khotanRuntimeRegistry.set(instanceId, {
    cache: createCacheInstance,
    appendRunUpdate,
    mapping: createMappingInstance,
    listMappings,
    lookupMapping,
    upsertMapping,
    updateMapping,
    deleteMapping,
  });

  function dispose(): void {
    khotanRuntimeRegistry.delete(instanceId);
  }

  return {
    handler,
    init,
    flow,
    reconcileStuckRuns,
    wire,
    cache: createCacheInstance,
    mapping: createMappingInstance,
    listMappings,
    lookupMapping,
    upsertMapping,
    updateMapping,
    deleteMapping,
    getVars,
    setVars,
    clearVars,
    hasVars,
    getVarFields,
    getPlug,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// toNextJsHandler
// ---------------------------------------------------------------------------

export interface NextJsRequest extends Request {
  nextUrl?: URL;
}

export interface NextJsRouteHandlers {
  GET: (req: NextJsRequest) => Promise<Response>;
  POST: (req: NextJsRequest) => Promise<Response>;
  PUT: (req: NextJsRequest) => Promise<Response>;
  PATCH: (req: NextJsRequest) => Promise<Response>;
  DELETE: (req: NextJsRequest) => Promise<Response>;
}

export function toNextJsHandler(
  factoryHandler: KhotanHandler,
): NextJsRouteHandlers {
  function handle(req: NextJsRequest): Promise<Response> {
    return factoryHandler(req);
  }

  return {
    GET: handle,
    POST: handle,
    PUT: handle,
    PATCH: handle,
    DELETE: handle,
  };
}
