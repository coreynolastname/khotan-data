# khotan-data

Data sync, ETL, and webhook primitives for Next.js + Drizzle + Postgres. shadcn for data plumbing.

Built for **Next.js + Drizzle + Postgres** projects. Think shadcn × better-auth, but for data.

## Install

```bash
npm i khotan-data
```

Requires `drizzle-orm` as a peer dependency (you almost certainly already have it).

## CLI

Scaffold components into your Next.js + Drizzle project:

```bash
# Initialize khotan config
npx khotan-data init

# Full setup (drizzle + shadcn + config in one go)
npx khotan-data init --full

# Initialize and scaffold khotan Drizzle tables
npx khotan-data init --schema --yes

# Skills only (install agent skills; skip config + core files + package install)
npx khotan-data init --skills-only

# Add components (reusable building blocks — never create pages)
npx khotan-data add schema    # Drizzle table definitions (plugs, flows, runs, resources, mappings)
npx khotan-data add auth      # Better Auth setup + khotan authorize hook
npx khotan-data add cache     # Durable key/value caches for workflows and relays
npx khotan-data add plug      # Fetch wrapper with auth, retry, pagination
npx khotan-data add inflow    # Workflow-backed flow for pulling data in
npx khotan-data add outflow   # Workflow-backed flow for pushing data out
npx khotan-data add relay     # Workflow-backed flow for moving data between plugs
npx khotan-data add cron      # Vercel cron dispatcher for scheduled flows
npx khotan-data add hub       # Dashboard UI + API route + config (requires shadcn)

# Add blocks (sample pages composed from components)
npx khotan-data add config-page-1   # /config page that renders the KhotanHub dashboard

# Options
npx khotan-data add schema --force   # Overwrite existing files without prompting
npx khotan-data add hub --yes        # Non-interactive mode: auto-accept all prompts
npx khotan-data generate --force     # Regenerate schema (prompts before overwriting by default)

# Ops guardrails
npx khotan-data --env-file .env.customer whoami --assert-org org_123
npx khotan-data databases bind primary neon/project/db --url-env DATABASE_URL
npx khotan-data apps env prepare web --database primary
npx khotan-data bootstrap            # Config + route bootstrap without package installs
```

`whoami` resolves the current organization from `--org-id`, `KHOTAN_ORG_ID`, or
an explicit `--env-file`, then fails fast when `--assert-org` does not match.
Database and app env commands write `khotan.bindings.json` only; they do not
call provider APIs or synthesize database URLs. Use the recorded `databaseId`
with your platform-specific deployment tooling.

## Factory (Runtime Engine)

Register plugs, caches, flows, and resources — the factory upserts them on boot and serves a REST API:

```typescript
import { khotan, drizzleAdapter } from "khotan-data/factory";
import { db } from "@/db";
import { shopifyPlug } from "@/lib/khotan/plugs/shopify";
import { shopifyProductsInflow } from "@/lib/khotan/flows/shopify-products";
import { shopifyProductsSnapshotCache } from "@/lib/khotan/caches/shopify-products-snapshot";

const khotanData = khotan({
  adapter: drizzleAdapter(db),
  // Gate the management API behind your auth layer (see "Security" below).
  authorize: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return Boolean(session?.user);
  },
  resources: [
    { name: "products", mapping: { connectField: "sku" } },
  ],
  caches: [
    shopifyProductsSnapshotCache,
  ],
  plugs: [
    {
      name: "shopify",
      plug: shopifyPlug,
      flows: [
        shopifyProductsInflow,
      ],
    },
  ],
});

export default khotanData;
```

`khotan-data init` also generates the catch-all route with `toNextJsHandler` and a relative import back to that instance:

```typescript
// Next.js App Router: app/api/khotan/[...all]/route.ts
import { toNextJsHandler } from "khotan-data/factory";
import khotanData from "../../../../khotan/khotan";

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(
  khotanData.handler,
);
```

`khotan-data/next` remains available as a compatibility helper for projects that expose the standard `@/khotan/khotan` instance, but generated routes use direct imports so custom output directories keep working.

Start a flow through Khotan so run tracking and Workflow IDs are recorded:

```typescript
await khotanData.flow("products-inflow", { plugName: "shopify" }).start({
  variant: "delta",
});
```

For Workflow-backed flows, call `.start()` from compiled Next server code
(route handler, server action, cron path). Raw Node/Bun scripts that import
source workflow files can miss Workflow compiler metadata and fail with
`start-invalid-workflow-function`; for local script/QA testing, run the app and
use `npx khotan-data flows trigger products-inflow --plug shopify`.

### Lifecycle Hooks And Stuck Runs

Use factory-level hooks when operational logging or notifications should cover
every flow and accepted webhook without adding manual event-log calls to each
step:

```typescript
const khotanData = khotan({
  adapter: drizzleAdapter(db),
  authorize,
  onFlowRunComplete: async (ctx, run) => {
    await eventLog.info("flow.completed", { flow: ctx.flow.name, run });
  },
  onFlowRunFailed: async (ctx, run) => {
    await eventLog.error("flow.failed", { flow: ctx.flow.name, run });
  },
  onWebhookReceived: async (event) => {
    await eventLog.info("webhook.received", {
      plug: event.plug.name,
      eventType: event.eventType,
    });
  },
  plugs,
});
```

If a worker is interrupted and leaves a run in `pending` or `running`, reconcile
stale rows programmatically or through the management API. The Drizzle adapter
uses a guarded update so concurrent reconcilers do not double-claim the same
run.

```typescript
await khotanData.flow("products-inflow").reconcileStuck({
  olderThanMs: 30 * 60_000,
});

// Also available:
// POST /api/khotan/runs/reconcile-stuck
// POST /api/khotan/flows/{flowId}/runs/reconcile-stuck
```

### Transaction Boundary

`drizzleAdapter(db)` expects a normal Drizzle database handle for Khotan's own
metadata writes. Khotan does not open `db.transaction()` internally, and
generated starter code should not wrap Khotan factory boot, route handlers, or
workflow-run bookkeeping inside an application transaction. Keep user-domain
transactions around your own reads/writes; call Khotan flow starts, mapping
updates, cache writes, and run tracking at the boundary after those transactions
commit, or make those operations idempotent if they are coordinated externally.

## Security

The management API (`/api/khotan/*`) exposes plug credentials and operational
controls. It is deny-by-default unless you wire an `authorize` hook. Omitting
`authorize` rejects management requests with `401` in development and throws at
startup in production. `authorize: false` explicitly opens management routes for
local development only and is rejected in production.

Run `npx khotan-data add auth` to scaffold a Better Auth setup and wire the hook, or
pass your own function. The hook receives the raw `Request` and returns
`true`/`false`, so it composes directly with session libraries like better-auth:

```typescript
authorize: async (request) => {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user?.role === "admin";
},
```

- `KHOTAN_SECRET` encrypts plug credentials **at rest** (AES-256-GCM). It is not
  an auth credential — it never gates requests, and **must not** be sent as a
  `Bearer` token. Management routes are gated only by `authorize` (plus a
  dev-only CLI HMAC token derived from the secret). A rejected request returns
  `401` with `code: "authorize_rejected"` and a `hint`. To trigger a flow over
  HTTP (`POST /api/khotan/flows/{flowId}/runs`), send a credential your
  `authorize` hook accepts — or just call `khotanData.flow(name).start()` from
  server code, which needs no auth. Set the secret to a high-entropy value.
- Inbound webhooks (verified via per-plug `onVerify`), the cron dispatcher
  (`CRON_SECRET`), and debug routes (`KHOTAN_DEBUG`, non-production only) are
  exempt from `authorize` automatically.
- `KHOTAN_DEBUG` is force-disabled when `NODE_ENV=production`. The cron route
  fails closed in production when `CRON_SECRET` is unset.
- `npx khotan-data init` creates or appends `.env.template` with the khotan
  environment variables. Generate `KHOTAN_SECRET` and `CRON_SECRET` with
  `openssl rand -hex 32`.
- Protect the Hub dashboard page (e.g. `/config`) with your app's middleware —
  `authorize` only guards the API.

## Caches

Use first-class caches when a flow, relay, catch, or pass needs durable state between runs.

```typescript
import { cache } from "@/lib/khotan/caches/cache";

export const shopifyProductsSnapshotCache = cache({
  name: "shopify-products-snapshot",
  scope: {
    plug: "shopify",
    resource: "products",
    flow: "shopify-products-inflow",
  },
  ttl: "6h",
});
```

Inside workflows, use `khotanCache(ctx, "name")` for snapshots, cursors, and dedupe markers:

Declare `"use step"` functions at module top level and pass them serializable
values only (`ctx` is plain data). Nesting steps inside the `"use workflow"`
function fails at runtime — the Workflow compiler cannot hoist closures that
capture workflow scope.

```typescript
import { khotanCache } from "khotan-data/factory";

// Step: top-level, retried independently, full Node.js access.
async function syncProducts(ctx: InflowContext) {
  "use step";
  const snapshotCache = khotanCache(ctx, "shopify-products-snapshot");
  const previous =
    (await snapshotCache.get<Array<Record<string, unknown>>>("latest")) ?? [];

  const response = await shopifyPlug.get<{ data?: Array<Record<string, unknown>> }>("/products");
  const records = Array.isArray(response.data) ? response.data : [];

  await snapshotCache.set("latest", records);

  return {
    extracted: records.length,
    transformed: records.length,
    created: records.length,
    metadata: { previousCount: previous.length },
  };
}

// Workflow: orchestration only.
async function shopifyProductsWorkflow(ctx: InflowContext) {
  "use workflow";
  return syncProducts(ctx);
}
```

Return a `FlowRunResult` from the workflow or from the final `"use step"` call.
Khotan observes the workflow return value and finalizes `khotan_runs` and
`khotan_flows` automatically, including counters, duration, `partial` status
when failures are non-zero, error text, and metadata. This returned
`FlowRunResult` is the production-safe contract for durable workflows because
hosted workflow contexts may be serialized and rehydrated. Inline `run(ctx)`
handlers also expose `ctx.finalize(result)` as an explicit escape hatch when
returning a final result is not practical.

## Load and write-back primitives

Use `khotanUpsert` for natural-key Drizzle loads that need dedupe, enum
coercion, and local-field preservation:

```typescript
import { khotanUpsert } from "khotan-data/drizzle";
import { db } from "@/db";
import { suppliers } from "@/db/schema";

await khotanUpsert(db, {
  table: suppliers,
  records,
  conflictKey: "code",
  excludeOnUpdate: ["emailDomain", "embedding"],
  dedupe: "first-wins",
  coerceEnum: {
    status: { active: "ACTIVE", inactive: "INACTIVE" },
  },
});
```

Use cache-backed helpers inside top-level `"use step"` functions for cursors,
delta skips, and disappeared-record reconciliation. Register the cache on your
`khotan(...)` instance first.

```typescript
import {
  createCursorHelper,
  deltaSkip,
  khotanCache,
} from "khotan-data/factory";

const productCursor = createCursorHelper<string>("shopify-products-cursor");

async function syncProducts(ctx: RelayContext) {
  "use step";

  const since = await productCursor.get(ctx);
  const response = await shopify.get<{ data: Product[]; nextCursor?: string }>(
    "/products",
    { params: since ? { cursor: since } : undefined },
  );

  const delta = await deltaSkip(
    ctx,
    "shopify-products-delta",
    response.data,
    (record) => record.code,
    { updateCache: false },
  );

  await hubspot.batchPost("/products", delta.changed, {
    batchSize: 200,
    concurrency: 2,
  });
  await delta.commit();

  if (response.nextCursor) {
    await productCursor.set(ctx, response.nextCursor);
  }
}
```

`deltaSkip` keeps the existing array return shape when `updateCache` is omitted.
For write-back flows, pass `{ updateCache: false }` and call `commit()` only
after the destination write succeeds, so failed writes do not advance the cached
hash snapshot.

For soft-delete or disappeared-record handling, keep a prior keyset in
`khotanCache` after a successful write-back and compare it with the current run:

```typescript
const keyCache = khotanCache(ctx, "shopify-product-keys");
const previousKeys = new Set((await keyCache.get<string[]>("last-success")) ?? []);
const currentKeys = new Set(records.map((record) => record.code));
const removed = [...previousKeys].filter((key) => !currentKeys.has(key));

await hubspot.batchPost("/products/delete", removed, {
  batchSize: 200,
  buildBody: (codes) => ({ codes }),
});
await keyCache.set("last-success", [...currentKeys]);
```

## Quick Start

```typescript
import { Pipeline, fromQuery, map, filter, toDrizzle } from "khotan-data";
import { db } from "@/db";
import { users, analytics } from "@/db/schema";
import { eq } from "drizzle-orm";

const result = await Pipeline.create("user-analytics")
  .extract(
    fromQuery("active-users", () =>
      db.select().from(users).where(eq(users.active, true))
    ),
  )
  .transform(filter("adults", (r) => r.age >= 18))
  .transform(
    map("enrich", (r) => ({
      userId: r.id,
      email: r.email.toLowerCase(),
      segment: r.age >= 65 ? "senior" : "standard",
      processedAt: new Date(),
    })),
  )
  .load(
    toDrizzle("write-analytics", (rows) =>
      db.insert(analytics).values(rows)
    ),
  )
  .run();
```

## Retry And Dedup

For non-Next.js workers or plug internals, `khotan-data/retry` exports
runtime-agnostic retry and SHA-256 dedupe helpers:

```typescript
import { createDedupKey, retry } from "khotan-data/retry";

const order = await retry(() => fetchOrder(orderId), {
  attempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
});

const dedupeKey = await createDedupKey(
  { provider: "stripe", eventId: "evt_123" },
  { prefix: "webhook" },
);
```

## Extractors

Pull data from Drizzle queries:

```typescript
import { fromQuery, fromQueryPaginated, fromQueryCursor } from "khotan-data/drizzle";

// One-shot query
const source = fromQuery("users", () =>
  db.select().from(users).where(eq(users.active, true))
);

// Auto-paginated for large tables
const source = fromQueryPaginated("all-orders", {
  pageSize: 5000,
  query: (limit, offset) =>
    db.select().from(orders).limit(limit).offset(offset),
});

// Full control with async generator
const source = fromQueryCursor("stream", async function* () {
  // your custom cursor/streaming logic
});
```

Generic extractors for testing and non-DB sources:

```typescript
import { fromArray, createExtractor } from "khotan-data";

const testSource = fromArray("mock", [{ id: 1 }, { id: 2 }]);
```

## Transforms

Composable, type-safe record transformations:

```typescript
import { map, filter, pick, omit, rename, flatMap, compose } from "khotan-data/transform";

// Map fields
.transform(map("normalize", (r) => ({ ...r, email: r.email.toLowerCase() })))

// Filter records (non-matching records are dropped)
.transform(filter("active-only", (r) => r.active))

// Pick/omit fields
.transform(pick("slim", ["id", "name", "email"]))
.transform(omit("strip-pii", ["ssn", "dob"]))

// Rename fields
.transform(rename("api-names", { firstName: "first_name" }))

// One-to-many expansion
.transform(flatMap("explode-tags", (r) =>
  r.tags.map((tag) => ({ ...r, tag }))
))

// Compose multiple transforms into one step
.transform(compose("pipeline", [filterStep, mapStep, renameStep]))
```

## Loaders

Write data into Drizzle tables:

```typescript
import { toDrizzle, toDrizzleTx } from "khotan-data/drizzle";

// Simple insert (auto-batches to stay under Postgres parameter limits)
const loader = toDrizzle("insert", (rows) =>
  db.insert(analytics).values(rows)
);

// Upsert
const loader = toDrizzle("upsert", (rows) =>
  db
    .insert(analytics)
    .values(rows)
    .onConflictDoUpdate({
      target: analytics.userId,
      set: { segment: sql`excluded.segment`, updatedAt: new Date() },
    })
);

// Transactional — all-or-nothing per batch
const loader = toDrizzleTx("tx-insert", db, (tx, rows) =>
  tx.insert(analytics).values(rows)
);

// Control batching for wide tables
const loader = toDrizzle("wide-table", writeFn, {
  columnsPerRow: 25, // auto-calculates safe batch size
});
```

## Pipeline

The `Pipeline` builder is immutable — each method returns a new instance:

```typescript
const base = Pipeline.create("etl")
  .extract(source)
  .transform(filterStep);

// Branch into different outputs
const toDb = base.load(toDrizzle("db", writeFn)).run();
const toFile = base.load(toFileSink).run();
```

### Options

```typescript
const result = await pipeline.run({
  batchSize: 500,          // records per load batch (default: 1000)
  continueOnError: true,   // collect errors in result.errors instead of throwing
  signal: controller.signal, // AbortSignal for cancellation
});
// result.cancelled is true when stopped via AbortSignal
// With continueOnError: false (default), errors reject the promise
```

### Events

```typescript
pipeline.on((event) => {
  if (event.type === "error") console.error(event.stepName, event.data);
  if (event.type === "pipeline:end") console.log("Done:", event.data);
});
```

## Subpath Imports

```typescript
import { Pipeline } from "khotan-data/pipeline";
import { map, filter } from "khotan-data/transform";
import { fromQuery, toDrizzle } from "khotan-data/drizzle";
import { inflow, outflow, relay, catchEvent, wire } from "khotan-data/factory";
```

## Development

```bash
npm install
npm run dev          # watch mode build
npm run test         # run tests
npm run test:integration # run integration tests
npm run e2e          # pack tarball + typecheck generated Next.js consumers
npm run playground   # pack/install into examples/playground and start Next.js
npm run test:watch   # watch mode tests
npm run check        # typecheck + lint + format + test
npm run build        # production build
```

## Contributing

1. Fork the repo and create a branch from `main` (`feat/`, `fix/`, `chore/`, etc.)
2. Make your changes with conventional commit messages (`type: short description`)
3. Run `npx changeset` and describe what changed — pick patch, minor, or major
4. Run `npm run check` to verify typecheck, lint, format, and tests all pass
5. Open a PR against `main`

Every PR that changes user-facing behavior should include a changeset file (the `.changeset/*.md` file created in step 3). Internal-only changes like refactors or test updates can skip this.

## License

MIT
