"use client";

import { useEffect, useState } from "react";
import { khotanFetch, ApiErrorState } from "./api-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLocalDateTime } from "./date-time";
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
  khotanRunId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  status:
    | "received"
    | "queued"
    | "processing"
    | "processed"
    | "ignored"
    | "failed"
    | "duplicate";
  idempotencyKey: string | null;
  duplicateOfWebhookEventId: string | null;
  attempts: number;
  processingStartedAt: string | null;
  completedAt: string | null;
  error: string | null;
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
  received: "outline",
  queued: "secondary",
  processing: "secondary",
  processed: "default",
  ignored: "outline",
  duplicate: "outline",
  pending: "outline",
  running: "secondary",
  completed: "default",
  partial: "secondary",
  failed: "destructive",
  cancelled: "outline",
} as const;

function formatHandler(item: WebhookEventItem): string {
  if (!item.handlerName) return "Unknown";
  if (!item.handlerType) return item.handlerName;
  return `${item.handlerType}:${item.handlerName}`;
}

export function KhotanWebhookEventsTable({
  pageSize = 10,
}: { pageSize?: number } = {}) {
  const [data, setData] = useState<PageResponse<WebhookEventItem> | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshKey, setRefreshKey] = useState(0);

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
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((v) => v + 1)}
        >
          Refresh
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
                <TableHead>Handler</TableHead>
                <TableHead>Plug</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Payload</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-sm text-muted-foreground"
                  >
                    Loading webhook events...
                  </TableCell>
                </TableRow>
              ) : data?.items.length ? (
                data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatLocalDateTime(item.receivedAt)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {item.eventType}
                    </TableCell>
                    <TableCell className="space-y-1 text-xs">
                      <Badge variant={statusVariant[item.status]}>
                        {item.status}
                      </Badge>
                      <div className="text-muted-foreground">
                        attempts {item.attempts}
                      </div>
                      {item.idempotencyKey ? (
                        <div className="font-mono text-muted-foreground">
                          {item.idempotencyKey}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatHandler(item)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.plugName ?? "-"}
                    </TableCell>
                    <TableCell className="space-y-1 text-xs">
                      <div className="font-mono text-muted-foreground">
                        {item.khotanRunId ?? "-"}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {item.runStatus ? (
                          <Badge variant={statusVariant[item.runStatus]}>
                            {item.runStatus}
                          </Badge>
                        ) : null}
                        <span className="font-mono text-muted-foreground">
                          {item.workflowRunId ?? "-"}
                        </span>
                      </div>
                      {item.duplicateOfWebhookEventId ? (
                        <div className="font-mono text-muted-foreground">
                          duplicate of {item.duplicateOfWebhookEventId}
                        </div>
                      ) : null}
                      {item.error ? (
                        <div className="text-destructive">{item.error}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-80">
                      <details>
                        <summary className="cursor-pointer text-sm text-primary">
                          View payload
                        </summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
                          {JSON.stringify(item.payload, null, 2)}
                        </pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={7}
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
