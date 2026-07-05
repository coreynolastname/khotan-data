import type {
  CacheEntryRecord,
  CacheRegistration,
  CacheScope,
  FlowRegistration,
  FlowVariant,
  FlowRunResult,
  KhotanTerminalRunStatus,
  ResourceConnectField,
  ResourceRegistration,
} from "./types.js";

// ---------------------------------------------------------------------------
// Small utility functions shared across factory modules
// ---------------------------------------------------------------------------

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coerceDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

export function toFlowRunResult(value: unknown): FlowRunResult | undefined {
  return value && typeof value === "object" ? value : undefined;
}

export function getFlowRunCounters(result: FlowRunResult | undefined) {
  return {
    extracted: result?.extracted ?? 0,
    transformed: result?.transformed ?? 0,
    created: result?.created ?? 0,
    updated: result?.updated ?? 0,
    deleted: result?.deleted ?? 0,
    failed: result?.failed ?? 0,
    skipped: result?.skipped ?? 0,
  };
}

export function resolveTerminalRunStatus(
  result: FlowRunResult | undefined,
  counters: ReturnType<typeof getFlowRunCounters>,
): KhotanTerminalRunStatus {
  if (
    result?.status === "completed" ||
    result?.status === "partial" ||
    result?.status === "failed" ||
    result?.status === "cancelled"
  ) {
    return result.status;
  }
  return counters.failed > 0 ? "partial" : "completed";
}

export const DEFAULT_VARIANT = "default";

/**
 * Normalize a flow registration into a non-empty map of variants. A flow that
 * declares no `variants` is treated as a single `default` variant carrying the
 * flow's top-level `schedule`. Validates variant names and the schedule/variants
 * mutual-exclusivity invariant; throws at config time on violation.
 */
export function normalizeFlowVariants(
  flow: FlowRegistration,
): Record<string, FlowVariant> {
  const hasVariants =
    flow.variants !== undefined && Object.keys(flow.variants).length > 0;

  if (!hasVariants) {
    return {
      [DEFAULT_VARIANT]: flow.schedule ? { schedule: flow.schedule } : {},
    };
  }

  if (flow.schedule !== undefined) {
    throw new Error(
      `Flow "${flow.name}" declares both a top-level "schedule" and "variants". ` +
        `Move the schedule into a variant (e.g. variants: { default: { schedule } }).`,
    );
  }

  const normalized: Record<string, FlowVariant> = {};
  for (const [name, config] of Object.entries(flow.variants!)) {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(
        `Flow "${flow.name}" declares a variant with an empty name`,
      );
    }
    if (name !== name.trim()) {
      throw new Error(
        `Flow "${flow.name}" variant name "${name}" must not have leading/trailing whitespace`,
      );
    }
    normalized[name] = config;
  }
  return normalized;
}

export function extractEventTypes(body: Record<string, unknown>): string[] {
  const candidates =
    body["eventTypes"] ??
    body["event_types"] ??
    body["events"] ??
    body["enabled_events"];
  if (Array.isArray(candidates)) return candidates as string[];
  return [];
}

export function serializeConnectField(
  connectField: ResourceConnectField,
): string {
  return Array.isArray(connectField)
    ? JSON.stringify(connectField)
    : connectField;
}

export function deserializeConnectField(
  connectField: unknown,
): ResourceConnectField {
  if (Array.isArray(connectField)) {
    return connectField as [string, ...string[]];
  }

  if (typeof connectField !== "string") {
    throw new Error("Resource connectField must be a string or string array");
  }

  const trimmed = connectField.trim();
  if (!trimmed.startsWith("[")) {
    return connectField;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((value) => typeof value === "string" && value.length > 0)
    ) {
      return parsed as [string, ...string[]];
    }
  } catch {
    // Keep the raw string for backward compatibility with older rows.
  }

  return connectField;
}

export function validateConnectField(
  resourceName: string,
  connectField: ResourceConnectField,
): void {
  if (typeof connectField === "string") {
    if (!connectField.trim()) {
      throw new Error(
        `Resource "${resourceName}" must declare a non-empty connectField`,
      );
    }
    return;
  }

  if (!Array.isArray(connectField) || connectField.length === 0) {
    throw new Error(
      `Resource "${resourceName}" must declare connectField as a string or non-empty ordered string array`,
    );
  }

  for (const field of connectField) {
    if (typeof field !== "string" || !field.trim()) {
      throw new Error(
        `Resource "${resourceName}" has an invalid composite connectField entry`,
      );
    }
  }
}

export function validateResourcePlugs(
  resource: ResourceRegistration,
  plugNames: Set<string>,
): void {
  if (resource.mapping.plugs === undefined) {
    return;
  }

  if (!isPlainObject(resource.mapping.plugs)) {
    throw new Error(
      `Resource "${resource.name}" must declare mapping.plugs as an object keyed by plug name`,
    );
  }

  for (const [plugName, declaration] of Object.entries(
    resource.mapping.plugs,
  )) {
    if (!plugNames.has(plugName)) {
      throw new Error(
        `Resource "${resource.name}" references unknown plug: "${plugName}"`,
      );
    }
    if (!isPlainObject(declaration)) {
      throw new Error(
        `Resource "${resource.name}" has an invalid plug declaration for "${plugName}"`,
      );
    }

    const keys = Object.keys(declaration);
    if (
      keys.length !== 1 ||
      typeof declaration.uniqueIdentifier !== "string" ||
      !declaration.uniqueIdentifier.trim()
    ) {
      throw new Error(
        `Resource "${resource.name}" must declare exactly one uniqueIdentifier for plug "${plugName}"`,
      );
    }
  }
}

export function normalizeCacheScope(
  cacheName: string,
  scope: CacheRegistration["scope"],
): CacheScope | undefined {
  if (scope === undefined) {
    return undefined;
  }

  if (!isPlainObject(scope)) {
    throw new Error(`Cache "${cacheName}" must declare scope as an object`);
  }

  const normalized: CacheScope = {};
  for (const key of ["plug", "resource", "flow"] as const) {
    const value = scope[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Cache "${cacheName}" has an invalid scope.${key} value`);
    }
    normalized[key] = value.trim();
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function parseCacheTtlSeconds(
  cacheName: string,
  ttl: CacheRegistration["ttl"],
): number | null {
  if (ttl === undefined) {
    return null;
  }

  if (typeof ttl === "number") {
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`Cache "${cacheName}" must declare a positive ttl`);
    }
    return Math.ceil(ttl);
  }

  if (typeof ttl !== "string") {
    throw new Error(
      `Cache "${cacheName}" must declare ttl as a string or number`,
    );
  }

  const normalized = ttl.trim().toLowerCase();
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(normalized);
  if (!match) {
    throw new Error(
      `Cache "${cacheName}" has an invalid ttl "${ttl}". Use values like "30s", "15m", or "6h"`,
    );
  }

  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const milliseconds =
    unit === "ms"
      ? amount
      : unit === "s"
        ? amount * 1_000
        : unit === "m"
          ? amount * 60_000
          : unit === "h"
            ? amount * 3_600_000
            : amount * 86_400_000;

  return Math.max(1, Math.ceil(milliseconds / 1_000));
}

export function validateCacheKey(key: string): void {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Cache key must be a non-empty string");
  }
}

export function coerceCacheEntryRecord(
  row: Record<string, unknown>,
): CacheEntryRecord | null {
  if (
    typeof row["id"] !== "string" ||
    typeof row["cacheId"] !== "string" ||
    typeof row["key"] !== "string"
  ) {
    return null;
  }

  return {
    id: row["id"],
    cacheId: row["cacheId"],
    key: row["key"],
    value: row["value"],
    version: typeof row["version"] === "string" ? row["version"] : undefined,
    expiresAt: coerceDate(row["expiresAt"]),
    createdAt: coerceDate(row["createdAt"]) ?? undefined,
    updatedAt: coerceDate(row["updatedAt"]) ?? undefined,
  };
}

export function isCacheEntryExpired(
  entry: CacheEntryRecord,
  now = new Date(),
): boolean {
  return entry.expiresAt !== null && entry.expiresAt.getTime() <= now.getTime();
}

/**
 * Decrypt-or-fallback: try decryptVars, fall back to plain JSON.parse, then {}.
 * Centralizes the pattern previously copy-pasted across getWireVars, webhook
 * handler, and getStoredVarsByPlugId.
 */
export async function readEncryptedJson(
  raw: string | null,
  secret: string,
  decrypt: (encrypted: string, secret: string) => Promise<string>,
): Promise<Record<string, string>> {
  if (!raw) return {};
  if (!secret) {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }
  try {
    const decrypted = await decrypt(raw, secret);
    return JSON.parse(decrypted) as Record<string, string>;
  } catch {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }
}

export function canonicalizeConnectValue(
  resource: ResourceRegistration,
  connectValue: unknown,
): string {
  const { connectField } = resource.mapping;

  if (Array.isArray(connectField)) {
    if (typeof connectValue === "string") {
      return connectValue;
    }
    if (!Array.isArray(connectValue)) {
      throw new Error(
        `Resource "${resource.name}" expects composite connectValue input matching connectField order`,
      );
    }
    if (connectValue.length !== connectField.length) {
      throw new Error(
        `Resource "${resource.name}" expects ${String(connectField.length)} connectValue parts in declared order`,
      );
    }

    const parts = connectValue.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "number" || typeof part === "boolean") {
        return String(part);
      }
      throw new Error(
        `Resource "${resource.name}" connectValue parts must be strings, numbers, or booleans`,
      );
    });

    return JSON.stringify(parts);
  }

  if (typeof connectValue === "string") {
    return connectValue;
  }
  if (typeof connectValue === "number" || typeof connectValue === "boolean") {
    return String(connectValue);
  }

  throw new Error(
    `Resource "${resource.name}" expects connectValue to be a string, number, or boolean`,
  );
}
