---
name: khotan-flow
description: >
  Build and run khotan Flows — durable inflows (pull data in), outflows (push
  data out), and relays (move data plug-to-plug) on Vercel Workflow. Use when
  the user wants to sync, pull, push, schedule, or migrate data between their
  app and an external service, or trigger a flow run from the CLI.
---

Build and run khotan Flows: durable data movement on Vercel Workflow. This is
Phase 5 of `khotan-build` (the pull/push/sync path; for event-driven webhooks
use `khotan-webhook`).

## When to use

- Pulling data from a service into your app (inflow).
- Pushing app data out to a service (outflow).
- Moving data directly between two services (relay).
- Scheduling or manually triggering any of the above.

## Order of operations

1. **Only build flows after the plug's endpoints are verified** with
   `khotan-probe`. Flows should sit on shapes you have confirmed.
2. Pick the flow type, scaffold it, author the workflow.
3. Register it on the plug in `{outputDir}/khotan.ts`.
4. Trigger once via CLI and confirm the run.

## STOP and ask when

- **Which flows are wanted.** Don't assume — ask the user which syncs they want
  unless they already told you.
- **Pagination depth.** Default to **one page** so the loop is fast, and tell
  the user explicitly: "this pulls a single page; full pagination needs X."

## Flow types

| Type | Direction | Scaffold |
|---|---|---|
| `inflow` | service → your app/DB | `npx khotan-data add inflow --yes` |
| `outflow` | your app/DB → service | `npx khotan-data add outflow --yes` |
| `relay` | service → service | `npx khotan-data add relay --yes` |

All three require `plug` + `schema` and the `workflow` package, and integrate
with Vercel Workflow.

## Authoring pattern (MUST)

Declare `"use step"` functions at **module top level** and pass only the
serializable `ctx` as an argument. The `"use workflow"` function does
orchestration only. **Never nest a step inside the workflow function** — the
Workflow compiler cannot hoist closures that capture workflow scope, and they
fail at runtime.

```typescript
import { inflow, type InflowContext } from "./inflow";
import { sendUpdate } from "khotan-data/factory";

// Step: top level, full Node.js access, retried independently.
async function extractAndLoad(ctx: InflowContext) {
  "use step";
  await sendUpdate({ message: "Starting product inflow", progress: 10 });

  // Quick-fire: ONE page by default. Disclose this to the user.
  const res = await fetch("https://api.example.com/products?page=1", {
    headers: { Authorization: `Bearer ${ctx.vars["apiToken"] ?? ""}` },
  });
  const payload = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const records = payload.data ?? [];

  // Replace with your app-specific transform + DB upsert.
  return { extracted: records.length, transformed: records.length, created: records.length };
}

// Workflow: orchestration only.
async function productsWorkflow(ctx: InflowContext) {
  "use workflow";
  return extractAndLoad(ctx);
}

export const productsInflow = inflow({
  name: "products-inflow",
  resource: "products",
  schedule: "0 * * * *",
  workflow: productsWorkflow,
});
```

Outflows query your DB and push out; relays read a source plug and write a
destination plug. The step/workflow rules are identical for all three.

Return a `FlowRunResult` from the workflow, usually by returning the last
`"use step"` result. Khotan observes that return value and finalizes
`khotan_runs` + `khotan_flows` automatically: counters, duration, terminal
status (`partial` when failures are non-zero), error, and metadata. Treat the
returned `FlowRunResult` as the production-safe contract for durable workflows;
hosted workflow contexts can be serialized and rehydrated, so workflow args do
not expose `ctx.finalize`. Inline `run(ctx)` handlers can use
`ctx.finalize(result)` as an explicit escape hatch when returning a final result
is not practical.

## Registering

In `{outputDir}/khotan.ts`, register flows under their source plug:

```typescript
import { productsInflow } from "./flows/products-inflow";

plugs: [
  {
    name: "shopify",
    plug: shopifyPlug,
    flows: [productsInflow],
  },
],
```

## Triggering

Always start a flow through khotan so run tracking and Workflow IDs are
recorded. Never call the workflow function directly.

```typescript
import khotanData from "@/lib/khotan/khotan";

await khotanData.flow("products-inflow", { plugName: "shopify" }).start({
  variant: "delta", // the run mode; defaults to "default"
});
```

Use this form from compiled app/server code (route handlers, server actions,
cron paths). Workflow-backed flows need Workflow compiler metadata; do not import
your khotan config into a raw Node/Bun script and call `.start()` there.

`plugName` only disambiguates when the same flow name is registered under
multiple plugs. `flow(name).start(options)` is the single entry point for manual
and scheduled runs alike.

### From the CLI (dev)

```bash
npx khotan-data flows list
npx khotan-data flows trigger <flowName>            # runs the "default" variant
npx khotan-data flows trigger <flowName> delta      # runs the "delta" variant
npx khotan-data flows trigger <flowName> --variant healthcheck
npx khotan-data flows runs <flowName>
npx khotan-data flows cancel <runId>
```

The CLI signs a short-lived HMAC token from `KHOTAN_SECRET` (the `KhotanCLI`
auth scheme, disabled when `NODE_ENV=production`). The raw secret never leaves
your machine.

### Over HTTP (scripts / external services)

There is **no** `POST /flows/:name/run` route. The HTTP trigger is:

```
POST /api/khotan/flows/{flowId}/runs    body: { "variant": "delta" }
```

This is a **management route**, so it goes through your `authorize` hook.
Gotcha: `KHOTAN_SECRET` is an encryption key, **not** an HTTP credential —
sending `Authorization: Bearer <KHOTAN_SECRET>` returns `401` with
`code: authorize_rejected`. Authenticate with a credential your `authorize` hook
accepts (a session cookie, or your own token you validate inside `authorize`).
For script/QA helpers outside the app runtime, run the Next app (`npm run dev`)
and use `npx khotan-data flows trigger <flowName>` or POST the route above.
Do not call `.start()` from a raw Node/Bun script that imports source workflow
files; it can fail with `start-invalid-workflow-function` because the Workflow
compiler metadata is missing.

## Variants (run modes)

A flow can declare a `variants` map of named run modes, each with its own
optional `schedule` and lifecycle hooks. The variant **name** is the mode —
flow code branches on `ctx.variant`. A flow that declares no `variants` is
treated as having a single implicit `default` variant carrying the top-level
`schedule` (so `ctx.variant === "default"`).

`variants` and a top-level `schedule` are **mutually exclusive** — put the
schedule inside a variant.

```typescript
import { inflow, type InflowContext } from "./inflow";
import { slackNotifier } from "khotan-data/factory";

export const itemsInflow = inflow({
  name: "pronto-items-inflow",
  resource: "items",
  variants: {
    // Cheap daily probe.
    healthcheck: {
      schedule: "0 6 * * *",
      onError: slackNotifier(process.env.SLACK_WEBHOOK_URL!),
    },
    // Changes since the last run — branch on ctx.variant in your step.
    delta: { schedule: "*/15 * * * *" },
    // Full weekly rebuild.
    full: { schedule: "0 2 * * 0" },
    // No schedule → manual-only.
    backfill: {},
  },
  workflow: itemsWorkflow,
});
```

Inside the workflow, branch on the active variant:

```typescript
async function extractAndLoad(ctx: InflowContext) {
  "use step";
  const since = ctx.variant === "delta" ? await loadCursor(ctx) : undefined;
  // ...fetch full vs. changed-only based on ctx.variant...
}
```

### Lifecycle hooks

Each variant may declare `onError` (fires on `failed`/`partial`) and
`onComplete` (fires on success). Hooks receive `(ctx, run)` where `run`
summarizes the finished run (status, variant, durationMs, counters, error).
Use the built-in `slackNotifier(webhookUrl)` or write your own. A throwing hook
is caught and logged — it never changes the recorded run status.

### Triggering a variant

```typescript
await khotanData.flow("pronto-items-inflow").start({ variant: "delta" });
```

```bash
npx khotan-data flows trigger pronto-items-inflow delta
```

If a flow declares variants and none is named `default`, triggering without a
variant fails with an error listing the available variant names.

> Migration note: `runType` is replaced by `variant`. `--run-type` (CLI) and
> `{ runType }` (API/`start`) still work as deprecated aliases for one minor
> release. The `khotan_runs.run_type` column is replaced by `variant` (the mode)
> plus `source` (`scheduled` | `manual` | `webhook`).

## Scheduling on Vercel

Flow `schedule` values are runtime source-of-truth metadata. On Vercel, prefer a
single dispatcher cron instead of one platform cron per flow.

```json
// vercel.json
{ "crons": [{ "path": "/api/khotan/cron", "schedule": "* * * * *" }] }
```

Then set `schedule` on each flow (or per variant). The dispatcher evaluates
every flow × variant on each tick and starts any whose `schedule` is due,
passing that variant name. Variants without a `schedule` are manual-only. If
`CRON_SECRET` is set, Vercel calls the route with
`Authorization: Bearer <CRON_SECRET>`.

## Related

- Reuse expensive upstream snapshots between runs → `khotan-cache`.
- Match/dedupe records across services by canonical key → `khotan-mappings`.
