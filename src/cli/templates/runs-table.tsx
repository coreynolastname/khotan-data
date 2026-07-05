"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { khotanFetch, ApiErrorState } from "./api-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { formatLocalDateTime, formatLocalTime } from "./date-time";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface RunLogItem {
  id: string;
  variant: string;
  source: "scheduled" | "manual" | "webhook";
  status:
    | "pending"
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled";
  workflowRunId: string | null;
  sourceType: "flow" | "webhook" | "unknown";
  sourceName: string | null;
  sourceKind: "catch" | "pass" | null;
  plugName: string | null;
  startedAt: string;
  completedAt: string | null;
  extracted: number;
  transformed: number;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  error: string | null;
  metadata?: Record<string, unknown> | null;
}

interface PageResponse<T> {
  items: T[];
  page: {
    limit: number;
    offset: number;
    hasMore: boolean;
    prevOffset: number;
    nextOffset: number;
  };
}

const statusVariant = {
  pending: "outline",
  running: "secondary",
  completed: "default",
  partial: "secondary",
  failed: "destructive",
  cancelled: "outline",
} as const;

const statusLabel = {
  pending: "pending",
  running: "running",
  completed: "completed",
  partial: "partial",
  failed: "failed",
  cancelled: "cancelled",
} as const;

function formatSource(item: RunLogItem): string {
  if (!item.sourceName) return "Unknown";
  if (item.sourceType !== "webhook" || !item.sourceKind) return item.sourceName;
  return `${item.sourceKind}:${item.sourceName}`;
}

function formatCounts(item: RunLogItem): string {
  const parts = [
    item.extracted > 0 ? `extracted ${String(item.extracted)}` : null,
    item.transformed > 0 ? `transformed ${String(item.transformed)}` : null,
    item.created > 0 ? `created ${String(item.created)}` : null,
    item.updated > 0 ? `updated ${String(item.updated)}` : null,
    item.deleted > 0 ? `deleted ${String(item.deleted)}` : null,
    item.failed > 0 ? `failed ${String(item.failed)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : "-";
}

function formatStreamLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const timestamp =
      typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
    const message =
      typeof parsed.message === "string" ? parsed.message : undefined;
    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    const parsedDate = timestamp ? new Date(timestamp) : null;
    const prefix =
      parsedDate && !Number.isNaN(parsedDate.getTime())
        ? `[${formatLocalTime(parsedDate, { includeSeconds: true })}] `
        : "";
    const typeLabel = type ? `${type}: ` : "";
    const detail = { ...parsed };
    delete detail.timestamp;
    delete detail.type;
    delete detail.message;
    const detailText =
      Object.keys(detail).length > 0
        ? `\n${JSON.stringify(detail, null, 2)}`
        : "";
    return `${prefix}${typeLabel}${message ?? line}${detailText}`;
  } catch {
    return line;
  }
}

function RunDetails({
  run,
  streamingEnabled,
  onChanged,
  onStreamInbound,
}: {
  run: RunLogItem;
  streamingEnabled: boolean;
  onChanged(): void;
  onStreamInbound(): void;
}) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const fetchDetail = useCallback(async (): Promise<
    Record<string, unknown>
  > => {
    const res = await fetch(`/api/khotan/runs/${run.id}`);
    if (!res.ok) throw new Error("Failed to load run detail");
    return (await res.json()) as Record<string, unknown>;
  }, [run.id]);

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      try {
        const json = await fetchDetail();
        if (!cancelled) setDetail(json);
        if (!cancelled) setLastUpdatedAt(new Date().toISOString());
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Unknown error");
      }
    }

    void loadDetail();
    if (!streamingEnabled) {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      void loadDetail();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fetchDetail, streamingEnabled]);

  useEffect(() => {
    const isLiveRun = run.status === "pending" || run.status === "running";
    if (!streamingEnabled && isLiveRun) return;

    const controller = new AbortController();
    let buffer = "";

    async function readStream() {
      try {
        const res = await fetch(
          `/api/khotan/runs/${run.id}/stream?startIndex=-50`,
          {
            signal: controller.signal,
          },
        );
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          const parsed = lines
            .map((line) => line.trim())
            .filter(Boolean)
            .map(formatStreamLine);
          if (parsed.length > 0) {
            setStreamLines((prev) => [...prev, ...parsed].slice(-100));
            setLastUpdatedAt(new Date().toISOString());
            if (streamingEnabled) onStreamInbound();
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Unknown stream error");
        }
      }
    }

    void readStream();
    if (streamingEnabled) {
      return () => controller.abort();
    }

    const timeout = window.setTimeout(() => controller.abort(), 2000);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [onStreamInbound, run.id, run.status, streamingEnabled]);

  async function refreshDetail() {
    setError(null);
    try {
      const json = await fetchDetail();
      setDetail(json);
      setLastUpdatedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function postAction(action: "cancel" | "retry") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/khotan/runs/${run.id}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Failed to ${action} run`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(null);
    }
  }

  const workflowStatus =
    typeof detail?.["workflowStatus"] === "string"
      ? detail["workflowStatus"]
      : null;

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1 text-sm">
          <div>
            <span className="font-medium">Khotan run:</span>{" "}
            <code className="text-xs">{run.id}</code>
          </div>
          <div>
            <span className="font-medium">Workflow status:</span>{" "}
            {workflowStatus ?? "unknown"}
          </div>
          {run.workflowRunId ? (
            <div>
              <span className="font-medium">Workflow run:</span>{" "}
              <code className="text-xs">{run.workflowRunId}</code>
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground">
            Last updated:{" "}
            {lastUpdatedAt
              ? formatLocalDateTime(lastUpdatedAt)
              : "Not loaded yet"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={streamingEnabled}
            onClick={() => void refreshDetail()}
          >
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              !run.workflowRunId || busy !== null || run.status !== "running"
            }
            onClick={() => void postAction("cancel")}
          >
            {busy === "cancel" ? "Cancelling..." : "Cancel"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || run.sourceType !== "flow"}
            onClick={() => void postAction("retry")}
          >
            {busy === "retry" ? "Retrying..." : "Retry"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="rounded-md bg-background p-3">
        <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
          Run updates
        </div>
        {streamLines.length > 0 ? (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs">
            {streamLines.join("\n")}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            {streamingEnabled
              ? "No run updates yet. Use sendUpdate(ctx, ...) inside Workflow steps to emit progress."
              : run.status === "pending" || run.status === "running"
                ? "Streaming is off. Turn it on to follow live Workflow updates."
                : "No persisted updates found for this completed run."}
          </p>
        )}
        {!streamingEnabled && streamLines.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Streaming is off. Showing the last loaded run updates.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function KhotanRunsTable({ pageSize = 10 }: { pageSize?: number } = {}) {
  const [data, setData] = useState<PageResponse<RunLogItem> | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [streamingEnabled, setStreamingEnabled] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [streamPulse, setStreamPulse] = useState(false);

  const pulseLiveIndicator = useCallback(() => {
    setStreamPulse(true);
    window.setTimeout(() => setStreamPulse(false), 700);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const json = await khotanFetch<PageResponse<RunLogItem>>(
          `/api/khotan/runs?limit=${String(pageSize)}&offset=${String(offset)}`,
        );
        if (!cancelled) {
          setData(json);
          setLastUpdatedAt(new Date().toISOString());
        }
      } catch (err) {
        if (!cancelled) {
          setError(err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [offset, pageSize, refreshKey]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle>Runs</CardTitle>
          <p className="text-sm text-muted-foreground">
            Recent flow and webhook execution history.
          </p>
          <p className="text-xs text-muted-foreground">
            Last updated:{" "}
            {lastUpdatedAt
              ? formatLocalDateTime(lastUpdatedAt)
              : "Not loaded yet"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex h-2.5 w-2.5">
              {streamingEnabled && streamPulse ? (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              ) : null}
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                  streamingEnabled ? "bg-emerald-500" : "bg-muted-foreground/40"
                }`}
              />
            </span>
            {streamingEnabled ? "Live" : "Idle"}
          </div>
          <Button
            aria-label="Refresh runs"
            title="Refresh runs"
            variant="outline"
            size="sm"
            onClick={() => setRefreshKey((v) => v + 1)}
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2 text-sm">
            <span>Streaming</span>
            <Switch
              checked={streamingEnabled}
              onCheckedChange={setStreamingEnabled}
              aria-label="Toggle run streaming"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <ApiErrorState
            error={error}
            onRetry={() => setRefreshKey((v) => v + 1)}
            compact
          />
        ) : null}

        {error ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Plug</TableHead>
                <TableHead>Variant</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Counts</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-sm text-muted-foreground"
                  >
                    Loading runs...
                  </TableCell>
                </TableRow>
              ) : data?.items.length ? (
                data.items.map((item) => (
                  <Fragment key={item.id}>
                    <TableRow>
                      <TableCell className="text-sm text-muted-foreground">
                        <div>{formatLocalDateTime(item.startedAt)}</div>
                        <div className="text-xs">
                          {item.completedAt
                            ? `completed ${formatLocalDateTime(item.completedAt)}`
                            : "in progress"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant[item.status]}>
                          {statusLabel[item.status]}
                        </Badge>
                        {item.error ? (
                          <div
                            className="mt-1 max-w-56 truncate text-xs text-destructive"
                            title={item.error}
                          >
                            {item.error}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatSource(item)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.plugName ?? "-"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {item.variant}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.source}
                      </TableCell>
                      <TableCell className="max-w-64 text-xs text-muted-foreground">
                        {formatCounts(item)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {item.workflowRunId ?? "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setExpandedRunId((current) =>
                              current === item.id ? null : item.id,
                            )
                          }
                        >
                          {expandedRunId === item.id ? "Hide" : "Details"}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expandedRunId === item.id ? (
                      <TableRow>
                        <TableCell colSpan={9}>
                          <RunDetails
                            run={item}
                            streamingEnabled={streamingEnabled}
                            onChanged={() => setRefreshKey((v) => v + 1)}
                            onStreamInbound={pulseLiveIndicator}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-sm text-muted-foreground"
                  >
                    No runs recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        {error ? null : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Page {Math.floor(offset / pageSize) + 1}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0 || loading}
                onClick={() => setOffset(Math.max(offset - pageSize, 0))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!data?.page.hasMore || loading}
                onClick={() => setOffset(offset + pageSize)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
