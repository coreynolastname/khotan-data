"use client";

import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { khotanFetch, ApiErrorState } from "./api-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDurationMs, formatLocalDateTime } from "./date-time";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface WebhookEventItem {
  id: string;
  wireId: string | null;
  webhookHandlerId: string | null;
  khotanRunId: string;
  eventType: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  receivedAt: string;
  handlerName: string | null;
  handlerType: "catch" | "pass" | null;
  plugName: string | null;
  workflowRunId: string | null;
  runStatus:
    | "pending"
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled"
    | null;
  runStartedAt: string | null;
  runCompletedAt: string | null;
  runDurationMs: number | null;
  runError: string | null;
  vercelDeploymentUrl?: string | null;
  vercelWorkflowRunUrl?: string | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function isLiveStatus(status: WebhookEventItem["runStatus"]): boolean {
  return status === "pending" || status === "running";
}

function getEventDurationMs(item: WebhookEventItem): number | null {
  if (
    typeof item.runDurationMs === "number" &&
    Number.isFinite(item.runDurationMs)
  ) {
    return item.runDurationMs;
  }
  const startedAt = parseTime(item.runStartedAt);
  if (!startedAt) return null;
  const completedAt =
    parseTime(item.runCompletedAt) ??
    (isLiveStatus(item.runStatus) ? Date.now() : null);
  return completedAt && completedAt >= startedAt
    ? completedAt - startedAt
    : null;
}

function formatEventDuration(item: WebhookEventItem): {
  label: string;
  hint: string;
} {
  const durationMs = getEventDurationMs(item);
  if (durationMs === null) {
    return { label: "-", hint: "not recorded" };
  }
  return {
    label: formatDurationMs(durationMs),
    hint:
      item.runDurationMs === null && isLiveStatus(item.runStatus)
        ? "elapsed"
        : "handler run",
  };
}

function formatHandler(item: WebhookEventItem): string {
  if (!item.handlerName) return "Unknown";
  if (!item.handlerType) return item.handlerName;
  return `${item.handlerType}:${item.handlerName}`;
}

function getAction(item: WebhookEventItem): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  if (item.runError || item.runStatus === "failed") {
    return { label: "Review", variant: "destructive" };
  }
  if (item.runStatus === "partial")
    return { label: "Review", variant: "secondary" };
  if (isLiveStatus(item.runStatus))
    return { label: "Watch", variant: "secondary" };
  if (!item.runStatus) return { label: "Check", variant: "outline" };
  return { label: "None", variant: "outline" };
}

function DetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="break-words text-sm">{children}</div>
    </div>
  );
}

function CodeValue({ children }: { children: ReactNode }) {
  return <code className="text-xs">{children}</code>;
}

function ExternalLinkAnchor({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
    </a>
  );
}

function JsonBlock({
  label,
  value,
  emptyLabel,
}: {
  label: string;
  value: unknown;
  emptyLabel: string;
}) {
  const hasValue =
    value !== null &&
    value !== undefined &&
    (!isRecord(value) || Object.keys(value).length > 0);

  return (
    <div className="rounded-md border bg-background p-3">
      <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      {hasValue ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}

function WebhookEventDetails({ item }: { item: WebhookEventItem }) {
  const duration = formatEventDuration(item);

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="grid gap-3 lg:grid-cols-4">
        <div className="space-y-3 rounded-md border bg-background p-3">
          <DetailField label="Event">
            <div>{item.eventType}</div>
            <CodeValue>{item.id}</CodeValue>
          </DetailField>
          <DetailField label="Received">
            {formatLocalDateTime(item.receivedAt)}
          </DetailField>
        </div>

        <div className="space-y-3 rounded-md border bg-background p-3">
          <DetailField label="Handler">{formatHandler(item)}</DetailField>
          <DetailField label="Handler ID">
            {item.webhookHandlerId ? (
              <CodeValue>{item.webhookHandlerId}</CodeValue>
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </DetailField>
          <DetailField label="Wire ID">
            {item.wireId ? (
              <CodeValue>{item.wireId}</CodeValue>
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </DetailField>
        </div>

        <div className="space-y-3 rounded-md border bg-background p-3">
          <DetailField label="Khotan run">
            <CodeValue>{item.khotanRunId}</CodeValue>
          </DetailField>
          <DetailField label="Workflow run">
            {item.workflowRunId ? (
              <div className="space-y-1">
                <CodeValue>{item.workflowRunId}</CodeValue>
                {item.vercelWorkflowRunUrl ? (
                  <div>
                    <ExternalLinkAnchor href={item.vercelWorkflowRunUrl}>
                      Open in Vercel
                    </ExternalLinkAnchor>
                  </div>
                ) : null}
              </div>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </DetailField>
          <DetailField label="Run status">
            {item.runStatus ? (
              <Badge variant={statusVariant[item.runStatus]}>
                {item.runStatus}
              </Badge>
            ) : (
              <Badge variant="outline">unlinked</Badge>
            )}
          </DetailField>
        </div>

        <div className="space-y-3 rounded-md border bg-background p-3">
          <DetailField label="Plug">{item.plugName ?? "-"}</DetailField>
          <DetailField label="Started">
            {formatLocalDateTime(item.runStartedAt, "-")}
          </DetailField>
          <DetailField label="Completed">
            {formatLocalDateTime(item.runCompletedAt, "-")}
          </DetailField>
          <DetailField label="Duration">
            <div>{duration.label}</div>
            <div className="text-xs text-muted-foreground">{duration.hint}</div>
          </DetailField>
        </div>
      </div>

      {item.runError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {item.runError}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <JsonBlock
          label="Payload"
          value={item.payload}
          emptyLabel="No payload recorded."
        />
        <JsonBlock
          label="Headers"
          value={item.headers}
          emptyLabel="No headers recorded."
        />
      </div>
    </div>
  );
}

export function KhotanWebhookEventsTable({
  pageSize = 10,
}: { pageSize?: number } = {}) {
  const [data, setData] = useState<PageResponse<WebhookEventItem> | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const json = await khotanFetch<PageResponse<WebhookEventItem>>(
          `/api/khotan/webhook-events?limit=${String(pageSize)}&offset=${String(offset)}`,
        );
        if (!cancelled) {
          setData(json);
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
          <CardTitle>Webhook Events</CardTitle>
          <p className="text-sm text-muted-foreground">
            Recent inbound events captured by Khotan before workflow execution.
          </p>
        </div>
        <Button
          aria-label="Refresh webhook events"
          title="Refresh webhook events"
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((v) => v + 1)}
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
        </Button>
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
                <TableHead>Received</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Time spent</TableHead>
                <TableHead>Action</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-sm text-muted-foreground"
                  >
                    Loading webhook events...
                  </TableCell>
                </TableRow>
              ) : data?.items.length ? (
                data.items.map((item) => {
                  const duration = formatEventDuration(item);
                  const action = getAction(item);
                  return (
                    <Fragment key={item.id}>
                      <TableRow>
                        <TableCell className="min-w-44 text-sm text-muted-foreground">
                          {formatLocalDateTime(item.receivedAt)}
                        </TableCell>
                        <TableCell className="min-w-56">
                          <div className="font-medium">{item.eventType}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatHandler(item)} / {item.plugName ?? "-"}
                          </div>
                        </TableCell>
                        <TableCell>
                          {item.runStatus ? (
                            <Badge variant={statusVariant[item.runStatus]}>
                              {item.runStatus}
                            </Badge>
                          ) : (
                            <Badge variant="outline">unlinked</Badge>
                          )}
                          {item.runError ? (
                            <div
                              className="mt-1 max-w-56 truncate text-xs text-destructive"
                              title={item.runError}
                            >
                              {item.runError}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="font-medium tabular-nums">
                            {duration.label}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {duration.hint}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={action.variant}>{action.label}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-expanded={expandedEventId === item.id}
                            onClick={() =>
                              setExpandedEventId((current) =>
                                current === item.id ? null : item.id,
                              )
                            }
                          >
                            {expandedEventId === item.id ? "Hide" : "Details"}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expandedEventId === item.id ? (
                        <TableRow>
                          <TableCell colSpan={6}>
                            <WebhookEventDetails item={item} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-sm text-muted-foreground"
                  >
                    No webhook events recorded yet.
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
