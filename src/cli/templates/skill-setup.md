---
name: khotan-setup
description: >
  Foundation reference for khotan-data in a Next.js + Drizzle + Postgres
  project. Use when initializing khotan, adding the database schema,
  configuring the factory, securing the management API, fixing
  middleware/workflow interception, or troubleshooting missing setup steps.
---

Foundation reference for khotan-data. Use when laying or repairing the base of a
khotan project. For the full integration journey (docs → plug → flows →
frontend) start from `khotan-build`, which points here for Phase 0.

## When to use

- Initializing khotan in a new project, or checking the foundation is sound.
- Adding/migrating the database schema, configuring the factory, or gating the
  management API with `authorize`.
- Diagnosing setup-level failures (missing modules, hanging workflow runs).

## Quick Start

```bash
npm install khotan-data
npx khotan-data init
npx khotan-data add schema --yes
npx khotan-data migrate
npx khotan-data add plug --yes
```

## What Init Creates

`npx khotan-data init` scaffolds three files (never overwrites existing):

| File | Purpose |
|------|---------|
| `khotan.config.ts` | CLI config — sets `outputDir` (default: `src/khotan` or `khotan`) |
| `{outputDir}/khotan.ts` | Factory config — register plugs, resources, adapter |
| `src/app/api/khotan/[...all]/route.ts` | Catch-all API route |

Use `npx khotan-data init --full` for greenfield projects — also installs drizzle-orm, postgres, drizzle-kit, and shadcn.

## Factory Config Pattern

Edit `{outputDir}/khotan.ts` after init:

```typescript
import { khotan, drizzleAdapter } from "khotan-data/factory";
import { db } from "@/db";
import { stripeChargesInflow } from "./flows/stripe-charges";

const khotanData = khotan({
  adapter: drizzleAdapter(db),
  resources: [
    { name: "products", mapping: { connectField: "sku" } },
    { name: "orders", mapping: { connectField: "order_number" } },
  ],
  plugs: [
    {
      name: "stripe",
      plug: stripePlug,
      flows: [
        stripeChargesInflow,
      ],
    },
  ],
});

export default khotanData;
```

The factory auto-upserts plugs, flows, and resources to the database on first API request.

## Route Handler

The generated catch-all route binds the khotan instance directly with
`toNextJsHandler` and a relative import computed from the route file to
`{outputDir}/khotan.ts`:

```typescript
import { toNextJsHandler } from "khotan-data/factory";
import khotanData from "../../../../khotan/khotan";

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(
  khotanData.handler,
);
```

`khotan-data/next` remains available as a compatibility convenience for projects
that expose the standard `@/khotan/khotan` instance, but generated routes use the
direct form so custom `outputDir` values work.

## Database Setup

```bash
npx khotan-data add schema --yes   # Scaffolds Drizzle table definitions
npx khotan-data migrate             # Generates + applies migrations (needs DATABASE_URL)
npx khotan-data migrate --push      # Or push directly without migration files
```

Tables created: `khotan_plugs`, `khotan_resources`, `khotan_flows`, `khotan_wires`, `khotan_runs`, `khotan_mappings`.

The schema command auto-detects your Drizzle schema directory, updates `drizzle.config.ts` glob pattern, and adds the barrel re-export.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | Postgres connection (used by Drizzle) |
| `KHOTAN_SECRET` | For variables | AES-256-GCM key for encrypting plug vars |
| `KHOTAN_DEBUG` | For debugging | Enables `/debug/*` routes and the `plug` CLI (`probe` alias). Automatically disabled when `NODE_ENV=production` |
| `KHOTAN_WEBHOOK_URL` | For webhooks | Public URL for wire callbacks |
| `CRON_SECRET` | For production cron | Protects the built-in `/api/khotan/cron` dispatcher route. The route fails closed in production when this is unset |

### Credential triage

When wiring a new service, decide where each value lives:

- **Plug var** (stored in DB, encrypted via `KHOTAN_SECRET`, editable in Hub/CLI)
  — for secrets/tokens the service issues to this integration.
- **Env var** — for infra/config that differs per deploy (base URLs, regions).

Rules of thumb:
- If `KHOTAN_SECRET` is unset or empty, generate one: `openssl rand -hex 32`.
- Set `KHOTAN_DEBUG=1` in **development only** — it auto-disables under
  `NODE_ENV=production`.

## Securing the Management API

The management API (`/api/khotan/*`) and the Hub dashboard expose plug
credentials and operational controls. The API is deny-by-default until you wire
an auth hook.

For Better Auth projects, scaffold the default setup and wire the hook:

```bash
npx khotan-data add auth --yes
```

Pass an `authorize` hook to `khotan({ ... })`. It receives the raw `Request` and
returns `true` to allow the request or `false` to reject it with `401`. It
composes directly with session libraries like better-auth:

```typescript
import { khotan, drizzleAdapter } from "khotan-data/factory";
import { auth } from "@/lib/auth";
import { db } from "@/db";

const khotanData = khotan({
  adapter: drizzleAdapter(db),
  authorize: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return Boolean(session?.user); // or: session?.user?.role === "admin"
  },
  plugs: [/* ... */],
});
```

Notes:
- `authorize` is **not** a replacement for `KHOTAN_SECRET` — that key only
  encrypts credentials at rest, it does not authenticate requests. Conversely,
  `KHOTAN_SECRET` is **not** an HTTP credential: do not send it as a Bearer
  token. Management routes are gated solely by `authorize` (plus the dev-only
  CLI HMAC token). A rejected request returns `401` with `code:
  authorize_rejected` and a `hint` explaining how to authenticate.
- Inbound webhooks (`POST /webhook/:plug`, verified per-plug via `onVerify`),
  the cron dispatcher (`CRON_SECRET`), and debug routes (`KHOTAN_DEBUG`,
  non-production only) are exempt from `authorize` automatically.
- Also protect the Hub dashboard page (e.g. `/config`) with your app's
  middleware — `authorize` only guards the API, not your React pages.
- Without `authorize`, khotan logs a startup warning and returns `401` for
  management routes in development; production startup throws.
- Set `authorize: false` to explicitly opt out in local development only.
  `authorize: false` throws in production.
  Always configure a real `authorize` hook before deploying.

## Next.js Config

Add to `next.config.ts` if using local/tarball install:

```typescript
const nextConfig = {
  serverExternalPackages: ["khotan-data"],
};
```

## Workflow Runtime & Middleware/Proxy

Inflows, outflows, relays, catch, and pass run on **Vercel Workflow**, which
communicates over `/.well-known/workflow/*`. If your app has a `middleware.ts`
(or `proxy.ts`) whose `matcher` captures these paths, durable runs **silently
fail** — steps never get invoked and runs hang.

`npx khotan-data init` detects a middleware/proxy file and warns when it may
intercept these paths. Exclude them from the matcher:

```typescript
// middleware.ts
export const config = {
  matcher: ["/((?!_next|.well-known/workflow).*)"],
};
```

If you do auth or rewrites manually (not via `matcher`), short-circuit early:

```typescript
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/.well-known/workflow")) {
    return NextResponse.next();
  }
  // ...your logic
}
```

Vercel Workflow also requires AI Gateway OIDC — run `vercel link` and
`vercel env pull` so `VERCEL_OIDC_TOKEN` is available locally.

## Triggering & scheduling flows

Flow triggering, HTTP trigger routes, and the Vercel cron dispatcher live in the
`khotan-flow` skill. The short version: start flows with
`khotanData.flow(name).start()` from compiled Next server code, or
`npx khotan-data flows trigger <name>` in dev. Do not call `.start()` from a raw
Node/Bun script that imports source workflow files; Workflow-backed flows need
compiler metadata. Never call the workflow function directly.

## Verify Setup

```bash
curl http://localhost:3000/api/khotan/plugs     # Should list registered plugs
curl http://localhost:3000/api/khotan/flows      # Should list flows
curl http://localhost:3000/api/khotan/resources   # Should list resources
```

## Build order

The integration journey (docs → plug → endpoint verification → flows/webhooks →
frontend), including all the consent gates, lives in `khotan-build`. Scheduling
flows on Vercel (the single cron-dispatcher pattern) lives in `khotan-flow`.

## Troubleshooting

- **Empty plug list**: Factory upserts on first request — hit any endpoint first, then check `/plugs`
- **"Cannot find module khotan-data"**: Add to `serverExternalPackages` in next.config.ts
- **Migration fails**: Ensure `DATABASE_URL` is set and Postgres is reachable
- **Init won't overwrite**: By design — delete the file manually if you need to re-scaffold
- **Flow/workflow runs hang or never start**: Check your `middleware.ts`/`proxy.ts` matcher excludes `/.well-known/workflow/*` (see "Workflow Runtime & Middleware/Proxy")
- **`start-invalid-workflow-function` from `.start()`**: You are probably starting a Workflow-backed flow from a raw Node/Bun script. Run the Next app and trigger through `npx khotan-data flows trigger <flowName>` or the generated `/api/khotan/flows/{flowId}/runs` route instead.
- **Step "is not a function" / fails to resolve at runtime**: Declare `"use step"` functions at module top level and pass `ctx` as an argument — never nest them inside the `"use workflow"` function (closures over workflow scope cannot be hoisted)
