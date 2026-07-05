"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { khotanFetch, ApiErrorState } from "./api-state";
import { formatLocalTime } from "./date-time";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type FlowType = "inflow" | "outflow" | "relay";
type WebhookType = "catch" | "pass";
type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | null;
type NodeCategory = "database" | "plug" | "flow" | "webhook";
type EdgeCategory = "inflow" | "outflow" | "relay" | "catch" | "pass";
type NodeHealth = "idle" | "active" | "failed";
type NodeLane = "plug" | "flow" | "database" | "webhook" | "destination";

interface PlugRecord {
  id: string;
  name: string;
  baseUrl: string;
  authType: string;
  enabled: boolean;
}

interface FlowRecord {
  id: string;
  plugId: string;
  name: string;
  type: FlowType;
  enabled: boolean;
  schedule?: string | null;
  effectiveSchedule?: string | null;
  variants?: Record<string, { schedule?: string | null }>;
  plugName?: string | null;
  lastRunStatus?: RunStatus;
  lastRunAt?: string | null;
  to?: string | null;
}

interface WebhookHandlerRecord {
  id: string;
  name: string;
  type: WebhookType;
  enabled: boolean;
  destinationPlugId: string | null;
  events?: string[] | null;
  lastRunStatus?: RunStatus;
  lastRunAt?: string | null;
  plugName: string;
}

interface RunRecord {
  id: string;
  status: Exclude<RunStatus, null>;
  sourceType: "flow" | "webhook" | "unknown";
  sourceName: string | null;
  sourceKind: WebhookType | null;
  plugName: string | null;
  startedAt: string;
}

interface RunPageResponse {
  items?: RunRecord[];
}

interface TopologySnapshot {
  plugs: PlugRecord[];
  flows: FlowRecord[];
  webhookHandlers: WebhookHandlerRecord[];
  runs: RunRecord[];
}

interface FilterOption {
  id: string;
  label: string;
  hint: string;
}

interface TopologyFilters {
  plugIds: string[];
  flowIds: string[];
  webhookIds: string[];
  healths: NodeHealth[];
}

interface GraphNodeModel {
  id: string;
  entityId: string;
  category: NodeCategory;
  lane: NodeLane;
  label: string;
  subtitle: string;
  detail?: string;
  health: NodeHealth;
  muted?: boolean;
  ownerPlugId?: string;
  isVirtual?: boolean;
}

interface GraphEdgeModel {
  id: string;
  source: string;
  target: string;
  category: EdgeCategory;
  health: NodeHealth;
  label: string;
  fallback?: boolean;
}

interface TopologyModel {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  filters: {
    plugs: FilterOption[];
    flows: FilterOption[];
    webhooks: FilterOption[];
  };
}

interface FilteredTopologyGraph {
  nodes: Array<Node<TopologyNodeData>>;
  edges: Edge[];
  stats: {
    visibleNodes: number;
    totalNodes: number;
    visibleEdges: number;
    activeNodes: number;
    failedNodes: number;
  };
  hasAnyConfiguredTopology: boolean;
  hasVisibleTopology: boolean;
}

interface TopologyNodeData {
  category: NodeCategory;
  label: string;
  subtitle: string;
  detail?: string;
  health: NodeHealth;
  muted?: boolean;
}

const POLL_INTERVAL_MS = 5000;
const LANE_X: Record<NodeLane, number> = {
  plug: 60,
  flow: 390,
  database: 720,
  webhook: 1040,
  destination: 1360,
};
const NODE_SPACING_Y = 160;
const HEALTH_ORDER: NodeHealth[] = ["idle", "active", "failed"];
const HEALTH_LABEL: Record<NodeHealth, string> = {
  idle: "Idle",
  active: "Running",
  failed: "Failed",
};
const CATEGORY_LABEL: Record<NodeCategory, string> = {
  database: "Database",
  plug: "Plug",
  flow: "Flow",
  webhook: "Webhook",
};
const FLOW_TYPE_LABEL: Record<FlowType, string> = {
  inflow: "Inflow",
  outflow: "Outflow",
  relay: "Relay",
};
const WEBHOOK_TYPE_LABEL: Record<WebhookType, string> = {
  catch: "Catch",
  pass: "Pass",
};

function formatTime(value: string | null | undefined): string {
  return formatLocalTime(value);
}

function normalizeRuns(value: unknown): RunRecord[] {
  if (Array.isArray(value)) {
    return value as RunRecord[];
  }

  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as RunPageResponse).items)
  ) {
    return (value as RunPageResponse).items ?? [];
  }

  return [];
}

function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

function flowRunKey(flow: Pick<FlowRecord, "name" | "plugName">): string {
  return `flow:${flow.plugName ?? "unknown"}:${flow.name}`;
}

function webhookRunKey(
  handler: Pick<WebhookHandlerRecord, "name" | "type" | "plugName">,
): string {
  return `webhook:${handler.plugName}:${handler.type}:${handler.name}`;
}

function runKey(run: RunRecord): string | null {
  if (run.sourceType === "flow" && run.sourceName && run.plugName) {
    return `flow:${run.plugName}:${run.sourceName}`;
  }

  if (
    run.sourceType === "webhook" &&
    run.sourceName &&
    run.sourceKind &&
    run.plugName
  ) {
    return `webhook:${run.plugName}:${run.sourceKind}:${run.sourceName}`;
  }

  return null;
}

function buildLatestRunMap(runs: RunRecord[]): Map<string, RunRecord> {
  const map = new Map<string, RunRecord>();

  for (const run of runs) {
    const key = runKey(run);
    if (!key || map.has(key)) continue;
    map.set(key, run);
  }

  return map;
}

function buildRunningRunSet(runs: RunRecord[]): Set<string> {
  const set = new Set<string>();

  for (const run of runs) {
    const key = runKey(run);
    if (!key || run.status !== "running") continue;
    set.add(key);
  }

  return set;
}

function deriveHealth(
  key: string,
  latestRuns: Map<string, RunRecord>,
  runningRuns: Set<string>,
  fallbackStatus?: RunStatus,
): NodeHealth {
  if (runningRuns.has(key) || fallbackStatus === "running") {
    return "active";
  }

  const latest = latestRuns.get(key);
  if (latest?.status === "failed" || fallbackStatus === "failed") {
    return "failed";
  }

  return "idle";
}

function resolvePlugNodeId(
  plugsById: Map<string, PlugRecord>,
  plugsByName: Map<string, PlugRecord>,
  destinationPlugId: string | null | undefined,
  fallbackName?: string | null,
): string | null {
  if (destinationPlugId && plugsById.has(destinationPlugId)) {
    return `plug:${destinationPlugId}`;
  }

  if (fallbackName && plugsByName.has(fallbackName)) {
    return `plug:${plugsByName.get(fallbackName)!.id}`;
  }

  return null;
}

function edgeLabel(category: EdgeCategory): string {
  switch (category) {
    case "inflow":
      return "pull";
    case "outflow":
      return "push";
    case "relay":
      return "relay";
    case "catch":
      return "catch";
    case "pass":
      return "pass";
  }
}

function buildTopologyModel(snapshot: TopologySnapshot): TopologyModel {
  const latestRuns = buildLatestRunMap(snapshot.runs);
  const runningRuns = buildRunningRunSet(snapshot.runs);
  const plugs = sortByName(snapshot.plugs);
  const flows = [...snapshot.flows].sort((a, b) =>
    `${a.plugName ?? ""}:${a.name}`.localeCompare(
      `${b.plugName ?? ""}:${b.name}`,
    ),
  );
  const webhookHandlers = [...snapshot.webhookHandlers].sort((a, b) =>
    `${a.plugName}:${a.type}:${a.name}`.localeCompare(
      `${b.plugName}:${b.type}:${b.name}`,
    ),
  );

  const plugsById = new Map(plugs.map((plug) => [plug.id, plug]));
  const plugsByName = new Map(plugs.map((plug) => [plug.name, plug]));
  const nodes: GraphNodeModel[] = [
    {
      id: "database:primary",
      entityId: "database:primary",
      category: "database",
      lane: "database",
      label: "App Database",
      subtitle: "Shared storage for synced resources",
      detail: "khotan resources + mappings",
      health: "idle",
    },
  ];
  const edges: GraphEdgeModel[] = [];

  for (const plug of plugs) {
    nodes.push({
      id: `plug:${plug.id}`,
      entityId: plug.id,
      category: "plug",
      lane: "plug",
      label: plug.name,
      subtitle: plug.baseUrl,
      detail: plug.enabled ? plug.authType : "disabled",
      health: "idle",
      muted: !plug.enabled,
      ownerPlugId: plug.id,
    });
  }

  for (const flow of flows) {
    const health = deriveHealth(
      flowRunKey(flow),
      latestRuns,
      runningRuns,
      flow.lastRunStatus,
    );

    nodes.push({
      id: `flow:${flow.id}`,
      entityId: flow.id,
      category: "flow",
      lane: "flow",
      label: flow.name,
      subtitle: FLOW_TYPE_LABEL[flow.type],
      detail:
        flow.effectiveSchedule ??
        flow.schedule ??
        flow.lastRunStatus ??
        "manual trigger",
      health,
      muted: !flow.enabled,
      ownerPlugId: flow.plugId,
    });

    if (flow.type === "inflow") {
      edges.push({
        id: `edge:plug-flow:${flow.id}`,
        source: `plug:${flow.plugId}`,
        target: `flow:${flow.id}`,
        category: "inflow",
        health,
        label: edgeLabel("inflow"),
      });
      edges.push({
        id: `edge:flow-db:${flow.id}`,
        source: `flow:${flow.id}`,
        target: "database:primary",
        category: "inflow",
        health,
        label: edgeLabel("inflow"),
      });
      continue;
    }

    if (flow.type === "outflow") {
      edges.push({
        id: `edge:db-flow:${flow.id}`,
        source: "database:primary",
        target: `flow:${flow.id}`,
        category: "outflow",
        health,
        label: edgeLabel("outflow"),
      });
      edges.push({
        id: `edge:flow-plug:${flow.id}`,
        source: `flow:${flow.id}`,
        target: `plug:${flow.plugId}`,
        category: "outflow",
        health,
        label: edgeLabel("outflow"),
      });
      continue;
    }

    edges.push({
      id: `edge:plug-flow:${flow.id}`,
      source: `plug:${flow.plugId}`,
      target: `flow:${flow.id}`,
      category: "relay",
      health,
      label: edgeLabel("relay"),
    });

    const relayTargetId = resolvePlugNodeId(
      plugsById,
      plugsByName,
      null,
      flow.to ?? null,
    );

    if (relayTargetId) {
      edges.push({
        id: `edge:relay-destination:${flow.id}`,
        source: `flow:${flow.id}`,
        target: relayTargetId,
        category: "relay",
        health,
        label: edgeLabel("relay"),
      });
      continue;
    }

    const fallbackRelayNodeId = `plug:virtual:relay:${flow.id}`;
    nodes.push({
      id: fallbackRelayNodeId,
      entityId: fallbackRelayNodeId,
      category: "plug",
      lane: "destination",
      label: "Destination unavailable",
      subtitle: "Relay target is not exposed by the current API payload",
      detail: flow.to ?? "scaffolded relay destination",
      health: "idle",
      muted: true,
      ownerPlugId: flow.plugId,
      isVirtual: true,
    });
    edges.push({
      id: `edge:relay-fallback:${flow.id}`,
      source: `flow:${flow.id}`,
      target: fallbackRelayNodeId,
      category: "relay",
      health,
      label: "relay target",
      fallback: true,
    });
  }

  for (const handler of webhookHandlers) {
    const sourcePlug = plugsByName.get(handler.plugName);
    if (!sourcePlug) continue;

    const health = deriveHealth(
      webhookRunKey(handler),
      latestRuns,
      runningRuns,
      handler.lastRunStatus,
    );

    nodes.push({
      id: `webhook:${handler.id}`,
      entityId: handler.id,
      category: "webhook",
      lane: "webhook",
      label: handler.name,
      subtitle: WEBHOOK_TYPE_LABEL[handler.type],
      detail: handler.events?.length
        ? handler.events.join(", ")
        : "wire events",
      health,
      muted: !handler.enabled,
      ownerPlugId: sourcePlug.id,
    });

    edges.push({
      id: `edge:plug-webhook:${handler.id}`,
      source: `plug:${sourcePlug.id}`,
      target: `webhook:${handler.id}`,
      category: handler.type,
      health,
      label: edgeLabel(handler.type),
    });

    if (handler.type === "catch") {
      edges.push({
        id: `edge:webhook-db:${handler.id}`,
        source: `webhook:${handler.id}`,
        target: "database:primary",
        category: "catch",
        health,
        label: edgeLabel("catch"),
      });
      continue;
    }

    const destinationNodeId = resolvePlugNodeId(
      plugsById,
      plugsByName,
      handler.destinationPlugId,
      null,
    );

    if (destinationNodeId) {
      edges.push({
        id: `edge:pass-destination:${handler.id}`,
        source: `webhook:${handler.id}`,
        target: destinationNodeId,
        category: "pass",
        health,
        label: edgeLabel("pass"),
      });
      continue;
    }

    const fallbackPassNodeId = `plug:virtual:pass:${handler.id}`;
    nodes.push({
      id: fallbackPassNodeId,
      entityId: fallbackPassNodeId,
      category: "plug",
      lane: "destination",
      label: "Destination unavailable",
      subtitle:
        "Pass target could not be resolved from the current plug registry",
      detail: handler.destinationPlugId ?? "configure a destination plug",
      health: "idle",
      muted: true,
      ownerPlugId: sourcePlug.id,
      isVirtual: true,
    });
    edges.push({
      id: `edge:pass-fallback:${handler.id}`,
      source: `webhook:${handler.id}`,
      target: fallbackPassNodeId,
      category: "pass",
      health,
      label: "pass target",
      fallback: true,
    });
  }

  return {
    nodes,
    edges,
    filters: {
      plugs: plugs.map((plug) => ({
        id: plug.id,
        label: plug.name,
        hint: `${plug.authType} ${plug.enabled ? "" : "• disabled"}`.trim(),
      })),
      flows: flows.map((flow) => ({
        id: flow.id,
        label: flow.name,
        hint: `${flow.plugName ?? "Unknown"} • ${FLOW_TYPE_LABEL[flow.type]}`,
      })),
      webhooks: webhookHandlers.map((handler) => ({
        id: handler.id,
        label: handler.name,
        hint: `${handler.plugName} • ${WEBHOOK_TYPE_LABEL[handler.type]}`,
      })),
    },
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function createDefaultFilters(model: TopologyModel): TopologyFilters {
  return {
    plugIds: model.filters.plugs.map((item) => item.id),
    flowIds: model.filters.flows.map((item) => item.id),
    webhookIds: model.filters.webhooks.map((item) => item.id),
    healths: [...HEALTH_ORDER],
  };
}

function reconcileFilters(
  current: TopologyFilters | null,
  model: TopologyModel,
): TopologyFilters {
  const defaults = createDefaultFilters(model);
  if (!current) return defaults;

  const next: TopologyFilters = {
    plugIds: current.plugIds.filter((id) => defaults.plugIds.includes(id)),
    flowIds: current.flowIds.filter((id) => defaults.flowIds.includes(id)),
    webhookIds: current.webhookIds.filter((id) =>
      defaults.webhookIds.includes(id),
    ),
    healths: current.healths.filter((value) =>
      defaults.healths.includes(value),
    ),
  };

  if (next.plugIds.length === 0 && defaults.plugIds.length > 0) {
    next.plugIds = defaults.plugIds;
  }
  if (next.flowIds.length === 0 && defaults.flowIds.length > 0) {
    next.flowIds = defaults.flowIds;
  }
  if (next.webhookIds.length === 0 && defaults.webhookIds.length > 0) {
    next.webhookIds = defaults.webhookIds;
  }
  if (next.healths.length === 0) {
    next.healths = defaults.healths;
  }

  if (
    arraysEqual(next.plugIds, current.plugIds) &&
    arraysEqual(next.flowIds, current.flowIds) &&
    arraysEqual(next.webhookIds, current.webhookIds) &&
    arraysEqual(next.healths, current.healths)
  ) {
    return current;
  }

  return next;
}

function layoutNodes(nodes: GraphNodeModel[]): Array<Node<TopologyNodeData>> {
  const laneIndexes: Record<NodeLane, number> = {
    plug: 0,
    flow: 0,
    database: 0,
    webhook: 0,
    destination: 0,
  };

  return nodes.map((node) => {
    const laneIndex = laneIndexes[node.lane]++;
    const yBase = node.lane === "database" ? 170 : 36;
    return {
      id: node.id,
      type: "topology",
      position: {
        x: LANE_X[node.lane],
        y: yBase + laneIndex * NODE_SPACING_Y,
      },
      draggable: true,
      data: {
        category: node.category,
        label: node.label,
        subtitle: node.subtitle,
        detail: node.detail,
        health: node.health,
        muted: node.muted,
      },
    };
  });
}

function reconcileNodes(
  current: Array<Node<TopologyNodeData>>,
  next: Array<Node<TopologyNodeData>>,
): Array<Node<TopologyNodeData>> {
  const currentById = new Map(current.map((node) => [node.id, node]));

  return next.map((node) => {
    const existing = currentById.get(node.id);
    if (!existing) return node;
    return {
      ...node,
      position: existing.position,
    };
  });
}

function buildEdgeStyle(edge: GraphEdgeModel): CSSProperties {
  return {
    strokeWidth:
      edge.health === "failed" ? 2.7 : edge.health === "active" ? 2.35 : 1.7,
    stroke:
      edge.health === "failed"
        ? "#ef4444"
        : edge.health === "active"
          ? "#f59e0b"
          : edge.fallback
            ? "#94a3b8"
            : "#475569",
    opacity: edge.fallback ? 0.72 : 0.96,
    strokeDasharray: edge.fallback ? "5 4" : undefined,
  };
}

function buildReactFlowGraph(
  model: TopologyModel,
  filters: TopologyFilters,
): FilteredTopologyGraph {
  const selectedPlugIds = new Set(filters.plugIds);
  const selectedFlowIds = new Set(filters.flowIds);
  const selectedWebhookIds = new Set(filters.webhookIds);
  const selectedHealths = new Set(filters.healths);

  const visibleNodeIds = new Set<string>();
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]));

  for (const node of model.nodes) {
    if (node.category === "flow") {
      if (
        selectedFlowIds.has(node.entityId) &&
        selectedHealths.has(node.health) &&
        (!node.ownerPlugId || selectedPlugIds.has(node.ownerPlugId))
      ) {
        visibleNodeIds.add(node.id);
      }
      continue;
    }

    if (node.category === "webhook") {
      if (
        selectedWebhookIds.has(node.entityId) &&
        selectedHealths.has(node.health) &&
        (!node.ownerPlugId || selectedPlugIds.has(node.ownerPlugId))
      ) {
        visibleNodeIds.add(node.id);
      }
      continue;
    }

    if (
      node.category === "plug" &&
      !node.isVirtual &&
      selectedPlugIds.has(node.entityId)
    ) {
      visibleNodeIds.add(node.id);
    }
  }

  for (const edge of model.edges) {
    const sourceVisible = visibleNodeIds.has(edge.source);
    const targetVisible = visibleNodeIds.has(edge.target);
    if (sourceVisible === targetVisible) continue;

    const counterpartId = sourceVisible ? edge.target : edge.source;
    const counterpart = nodesById.get(counterpartId);
    if (!counterpart) continue;

    if (
      counterpart.category === "plug" ||
      counterpart.category === "database"
    ) {
      visibleNodeIds.add(counterpart.id);
    }
  }

  const visibleEdges = model.edges.filter((edge) => {
    return visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target);
  });

  for (const edge of visibleEdges) {
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
  }

  const visibleNodes = model.nodes.filter((node) =>
    visibleNodeIds.has(node.id),
  );
  const laidOutNodes = layoutNodes(visibleNodes);
  const edges: Edge[] = visibleEdges.map((edge) => {
    const style = buildEdgeStyle(edge);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: "smoothstep",
      animated: edge.health === "active",
      style,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: style.stroke,
      },
      labelStyle: {
        fontSize: 10,
        fill: style.stroke as string,
      },
      labelBgStyle: {
        fill: "#ffffff",
        fillOpacity: 0.92,
      },
      labelBgPadding: [6, 2],
      labelBgBorderRadius: 999,
    };
  });

  return {
    nodes: laidOutNodes,
    edges,
    stats: {
      visibleNodes: visibleNodes.length,
      totalNodes: model.nodes.filter((node) => !node.isVirtual).length,
      visibleEdges: visibleEdges.length,
      activeNodes: visibleNodes.filter((node) => node.health === "active")
        .length,
      failedNodes: visibleNodes.filter((node) => node.health === "failed")
        .length,
    },
    hasAnyConfiguredTopology:
      model.filters.plugs.length > 0 &&
      (model.filters.flows.length > 0 || model.filters.webhooks.length > 0),
    hasVisibleTopology: visibleNodes.length > 0 && visibleEdges.length > 0,
  };
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function toggleHealth(values: NodeHealth[], value: NodeHealth): NodeHealth[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function summaryLabel(label: string, selected: number, total: number): string {
  if (total === 0) return label;
  if (selected === total) return `${label} (${total})`;
  return `${label} (${selected}/${total})`;
}

function FilterDropdown({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onToggle(id: string): void;
}) {
  if (options.length === 0) return null;

  return (
    <details className="group relative">
      <summary className="list-none rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:border-slate-300">
        {summaryLabel(label, selected.length, options.length)}
      </summary>

      <div className="absolute left-0 z-10 mt-2 w-[280px] rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
          {label}
        </div>
        <div className="max-h-72 space-y-2 overflow-auto pr-1">
          {options.map((option) => {
            const checked = selected.includes(option.id);
            return (
              <label
                key={option.id}
                className="flex cursor-pointer items-start gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(option.id)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-slate-800">
                    {option.label}
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {option.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function StatusDropdown({
  selected,
  onToggle,
}: {
  selected: NodeHealth[];
  onToggle(value: NodeHealth): void;
}) {
  return (
    <details className="group relative">
      <summary className="list-none rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:border-slate-300">
        {summaryLabel("Status", selected.length, HEALTH_ORDER.length)}
      </summary>

      <div className="absolute left-0 z-10 mt-2 w-48 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
          Status
        </div>
        <div className="space-y-2">
          {HEALTH_ORDER.map((health) => (
            <label
              key={health}
              className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(health)}
                onChange={() => onToggle(health)}
                className="h-4 w-4 rounded border-slate-300 text-slate-900"
              />
              <span className="flex items-center gap-2 text-xs text-slate-700">
                <span
                  className={`h-2 w-2 rounded-full ${
                    health === "failed"
                      ? "bg-red-500"
                      : health === "active"
                        ? "bg-amber-500"
                        : "bg-slate-400"
                  }`}
                />
                {HEALTH_LABEL[health]}
              </span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}

function TopologyNode({ data }: NodeProps<TopologyNodeData>) {
  const healthBorder =
    data.health === "failed"
      ? "border-red-300 shadow-red-100"
      : data.health === "active"
        ? "border-amber-300 shadow-amber-100"
        : "border-white/80 shadow-slate-200/70";
  return (
    <div
      className={`min-w-[220px] rounded-3xl border bg-white/88 p-4 shadow-lg backdrop-blur-xl ${healthBorder}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-0 !bg-slate-400"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-0 !bg-slate-500"
      />

      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-slate-950">
            {data.label}
          </div>
          <div className="text-xs text-slate-500">{data.subtitle}</div>
        </div>
        <div
          className={`mt-1 h-2.5 w-2.5 rounded-full ${
            data.health === "failed"
              ? "bg-red-500"
              : data.health === "active"
                ? "bg-amber-500"
                : "bg-slate-400"
          }`}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge
          variant="outline"
          className="border-slate-200 bg-white/70 text-slate-600"
        >
          {CATEGORY_LABEL[data.category]}
        </Badge>
        <Badge
          variant="outline"
          className={
            data.health === "failed"
              ? "border-red-200 bg-red-50 text-red-700"
              : data.health === "active"
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : "border-slate-200 bg-slate-50 text-slate-600"
          }
        >
          {HEALTH_LABEL[data.health]}
        </Badge>
        {data.muted ? (
          <Badge
            variant="outline"
            className="border-slate-200 bg-white/70 text-slate-500"
          >
            Disabled
          </Badge>
        ) : null}
      </div>

      {data.detail ? (
        <div className="mt-4 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">
          {data.detail}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  topology: TopologyNode,
};

function TopologyCanvasInner() {
  const [snapshot, setSnapshot] = useState<TopologySnapshot | null>(null);
  const [filters, setFilters] = useState<TopologyFilters | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<TopologyNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadTopology() {
      try {
        if (!cancelled) {
          setError(null);
        }

        const [plugs, flows, runsRaw] = await Promise.all([
          khotanFetch<PlugRecord[]>("/api/khotan/plugs"),
          khotanFetch<FlowRecord[]>("/api/khotan/flows"),
          khotanFetch<unknown>("/api/khotan/runs?limit=100"),
        ]);

        const runs = normalizeRuns(runsRaw);

        const webhookGroups = await Promise.all(
          plugs.map(async (plug) => {
            try {
              const handlers = await khotanFetch<
                Array<Omit<WebhookHandlerRecord, "plugName">>
              >(
                `/api/khotan/webhook-handlers/${encodeURIComponent(plug.name)}`,
              );
              return handlers.map((handler) => ({
                ...handler,
                plugName: plug.name,
              }));
            } catch {
              return [] as WebhookHandlerRecord[];
            }
          }),
        );

        if (cancelled) return;

        setSnapshot({
          plugs,
          flows,
          webhookHandlers: webhookGroups.flat(),
          runs,
        });
        setLastUpdatedAt(new Date().toISOString());
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadTopology();
    const interval = window.setInterval(() => {
      void loadTopology();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshKey]);

  const model = useMemo(() => {
    return snapshot ? buildTopologyModel(snapshot) : null;
  }, [snapshot]);

  useEffect(() => {
    if (!model) return;
    setFilters((current) => reconcileFilters(current, model));
  }, [model]);

  const graph = useMemo(() => {
    if (!model || !filters) return null;
    return buildReactFlowGraph(model, filters);
  }, [filters, model]);

  useEffect(() => {
    if (!graph) return;
    setNodes((current) => reconcileNodes(current, graph.nodes));
    setEdges(graph.edges);
  }, [graph, setEdges, setNodes]);

  const resetFilters = () => {
    if (!model) return;
    setFilters(createDefaultFilters(model));
  };

  if (loading) {
    return (
      <Card className="overflow-hidden border-white/70 bg-white/75 shadow-xl backdrop-blur">
        <CardHeader>
          <CardTitle>Topology Canvas</CardTitle>
          <CardDescription>
            Loading plugs, flows, webhook handlers, and recent runs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[720px] animate-pulse rounded-[28px] border border-dashed border-slate-200 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.96),_rgba(241,245,249,0.76))]" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-white/70 bg-white/80 shadow-xl backdrop-blur">
        <CardHeader>
          <CardTitle>Topology Canvas</CardTitle>
          <CardDescription>
            Could not load the graph from the local Khotan API.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiErrorState
            error={error}
            onRetry={() => setRefreshKey((v) => v + 1)}
          />
        </CardContent>
      </Card>
    );
  }

  if (!model || !graph) {
    return null;
  }

  if (!graph.hasAnyConfiguredTopology) {
    return (
      <Card className="overflow-hidden border-white/70 bg-white/80 shadow-xl backdrop-blur">
        <CardHeader>
          <CardTitle>Topology Canvas</CardTitle>
          <CardDescription>
            No graphable plugs, flows, or webhook handlers are configured yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-600">
          <p>
            Register at least one plug and one flow in your `khotan.ts` config,
            then refresh this page.
          </p>
          <p>
            Webhook handlers will appear automatically once a plug has a
            configured wire plus catch/pass registrations.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden border-white/70 bg-white/65 shadow-2xl backdrop-blur-xl">
      <CardHeader className="border-b border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.9),rgba(248,250,252,0.74))] pb-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className="border-slate-200 bg-white/90 text-slate-600"
            >
              Polling every {POLL_INTERVAL_MS / 1000}s
            </Badge>
            <Badge
              variant="outline"
              className="border-slate-200 bg-white/90 text-slate-600"
            >
              Visible {graph.stats.visibleNodes}/{graph.stats.totalNodes}
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-200 bg-amber-50 text-amber-700"
            >
              Running {graph.stats.activeNodes}
            </Badge>
            <Badge
              variant="outline"
              className="border-red-200 bg-red-50 text-red-700"
            >
              Failed {graph.stats.failedNodes}
            </Badge>
            <Badge
              variant="outline"
              className="border-slate-200 bg-white/90 text-slate-600"
            >
              Updated {formatTime(lastUpdatedAt)}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FilterDropdown
              label="Plugs"
              options={model.filters.plugs}
              selected={filters.plugIds}
              onToggle={(id) =>
                setFilters((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    plugIds: toggleValue(current.plugIds, id),
                  };
                })
              }
            />
            <FilterDropdown
              label="Flows"
              options={model.filters.flows}
              selected={filters.flowIds}
              onToggle={(id) =>
                setFilters((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    flowIds: toggleValue(current.flowIds, id),
                  };
                })
              }
            />
            <FilterDropdown
              label="Webhook handlers"
              options={model.filters.webhooks}
              selected={filters.webhookIds}
              onToggle={(id) =>
                setFilters((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    webhookIds: toggleValue(current.webhookIds, id),
                  };
                })
              }
            />
            <StatusDropdown
              selected={filters.healths}
              onToggle={(health) =>
                setFilters((current) => {
                  if (!current) return current;
                  return {
                    ...current,
                    healths: toggleHealth(current.healths, health),
                  };
                })
              }
            />
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
            >
              Reset
            </button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="h-[780px] bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.98),_rgba(241,245,249,0.88)_40%,_rgba(226,232,240,0.68)_100%)]">
          {graph.hasVisibleTopology ? (
            <ReactFlow
              fitView
              fitViewOptions={{ padding: 0.14 }}
              minZoom={0.35}
              maxZoom={1.7}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} size={1.1} color="#cbd5e1" />
              <MiniMap
                position="bottom-left"
                pannable
                zoomable
                style={{
                  background: "rgba(255,255,255,0.8)",
                  border: "1px solid rgba(226,232,240,0.9)",
                }}
                nodeColor={(node) => {
                  const nodeHealth = (node.data as TopologyNodeData | undefined)
                    ?.health;
                  if (nodeHealth === "failed") return "#ef4444";
                  if (nodeHealth === "active") return "#f59e0b";
                  return "#64748b";
                }}
              />
              <Controls
                position="bottom-right"
                className="[&>button]:border-white/80 [&>button]:bg-white/90 [&>button]:text-slate-700 [&>button]:shadow-sm"
                showInteractive={false}
              />
            </ReactFlow>
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-lg rounded-[28px] border border-white/80 bg-white/80 p-8 text-center shadow-xl backdrop-blur">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-600">
                  <Filter className="h-5 w-5" strokeWidth={1.8} />
                </div>
                <h3 className="text-lg font-semibold text-slate-950">
                  No topology matches the current filters
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Try re-enabling a plug, flow, webhook handler, or status chip.
                  The graph only shows connected topology that survives the
                  current filter set.
                </p>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="mt-5 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                >
                  <RotateCcw className="h-4 w-4" strokeWidth={1.8} />
                  Reset filters
                </button>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function KhotanTopologyCanvas() {
  return (
    <ReactFlowProvider>
      <TopologyCanvasInner />
    </ReactFlowProvider>
  );
}
