---
name: khotan-plug
description: >
  Create and configure khotan Plugs — HTTP clients for external APIs with
  auth, retry, pagination, and typed endpoints. Use when connecting to a
  new API, defining endpoint contracts, configuring authentication, or
  creating a typed API client.
---

Create and configure khotan Plugs — HTTP clients for external APIs with auth, retry, pagination, and typed endpoints. Use when connecting to a new API, defining endpoint contracts, configuring authentication, or creating a typed API client.

This is Phase 2 of `khotan-build`. Build the plug, then verify its endpoints
with `khotan-probe` before building flows.

## When to use

- Authoring or editing a plug: auth strategy, vars, typed endpoints, hooks.

## Order of operations

1. Confirm scope — which endpoints does the prompt actually need?
2. Create the plug with auth + a **small** set of typed `GET` endpoints.
3. Hand off to `khotan-probe` to verify shapes before anything downstream.

## STOP and ask when

- **Scope is unclear.** Do not guess which endpoints/resources to model — ask.
- **A mutation is involved.** Define `POST`/`PATCH`/`PUT`/`DELETE` endpoints if
  the contract needs them, but do not *fire* them against the live API without
  explicit user consent (see `khotan-probe`).

## Scaffold

```bash
npx khotan-data add plug --yes
```

Creates `{outputDir}/plugs/plug.ts` (the Plug runtime) and `plug.example.ts` (typed contract example).

## Creating a Plug

```typescript
import { plug, bearer, apiKey, basic, custom } from "./plug";

export const stripePlug = plug({
  name: "stripe",
  baseUrl: "https://api.stripe.com/v1",
  auth: bearer(process.env.STRIPE_KEY!),
  retry: { attempts: 3, backoff: 1000 },
  timeout: 30000,
});
```

## Pagination

Use `paginate()` in flows when the API has a predictable next-page shape. You can set a default strategy on the plug, pass one per call, or use an inline inspector for APIs that do not fit a reusable helper.

```typescript
for await (const products of myPlug.paginate("/products", {
  params: { limit: 100 },
  getItems: (res) => res["data"] as Array<{ id: string }>,
  hasMore: (res) =>
    Boolean((res["links"] as { next?: string | null }).next),
  getNext: (res) =>
    (res["links"] as { next?: string | null }).next,
  interPageDelayMs: 350,
})) {
  // sync this page
}
```

Built-in strategies cover common API shapes:

```typescript
import {
  envelopePagination,
  jsonApiPagination,
  linkPagination,
} from "./plug";

const api = plug({
  baseUrl: "https://api.example.com",
  pagination: linkPagination({ linksPath: "links.next", dataPath: "data" }),
});

await api.paginate("/orders", {
  pagination: jsonApiPagination({
    pageParam: "page[number]",
    lastPagePath: "meta.page.lastPage",
  }),
});

await api.paginate("/products", {
  params: { limit: 100 },
  pagination: envelopePagination({
    itemsPath: "items",
    hasMorePath: "hasMore",
    offsetParam: "offset",
  }),
});
```

`getNext` may return an absolute URL, a relative URL, or params to merge into the next request. `interPageDelayMs` waits between page requests for APIs that require courtesy delays.

## Auth Strategies

| Function | Usage |
|----------|-------|
| `bearer(token)` | `Authorization: Bearer <token>` — static string or async function |
| `basic(user, pass)` | `Authorization: Basic <base64>` |
| `apiKey(name, value)` | Custom header (default) or query param with `{ in: "query" }` |
| `custom(fn)` | Full control: `(headers) => { headers.set(...) }` |
| `hmacSignature(config)` | Signs with resolved `{ url, query, method, body, vars }` context |
| `tokenExchange(config)` | OAuth-style: exchanges variables/request context for bearer token, caches per key, optional durable `tokenStore`, auto-refreshes on 401 |
| `authorizationCode(config)` | OAuth authorization-code strategy with optional PKCE and refresh-token support |

`onUnauthorized` is part of an auth strategy, not `hooks`. The plug calls it
after a 401 with the same request vars/context used by `auth.apply`, then
re-applies auth and retries the request once.

### Token Exchange Example

```typescript
const auth = tokenExchange({
  getVariables: () => ({
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  }),
  tokenEndpoint: "/oauth/token",
  cacheKey: (vars, ctx) =>
    `${ctx.plugName}:${ctx.profile ?? "default"}:${vars.orgId}`,
  buildTokenRequest: (vars, ctx) => ({
    body: {
      grant_type: "client_credentials",
      client_id: vars.clientId,
      client_secret: vars.clientSecret,
      org_id: vars.orgId,
      target: ctx.profile ?? "default",
    },
  }),
  parseTokenResponse: (res) => ({
    accessToken: res.access_token,
    expiresIn: res.expires_in,
  }),
});
```

For OAuth servers that require `application/x-www-form-urlencoded`, pass a
`URLSearchParams` body and set the content type. The plug sends strings and
`URLSearchParams` verbatim; only plain objects are JSON encoded.

```typescript
const auth = tokenExchange({
  getVariables: () => ({
    clientId: process.env.OAUTH_CLIENT_ID!,
    clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  }),
  tokenEndpoint: "/oauth/token",
  cacheKey: (vars, ctx) =>
    `${ctx.plugName}:${ctx.profile ?? "default"}:${vars.orgId}`,
  buildTokenRequest: (vars, ctx) => ({
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: vars.clientId,
      client_secret: vars.clientSecret,
      org_id: vars.orgId,
      target: ctx.profile ?? "default",
    }),
  }),
  parseTokenResponse: (res) => ({
    accessToken: res.access_token,
    expiresIn: res.expires_in,
  }),
});
```

Use `tokenStore` when the token must survive cold starts. Token stores receive
the resolved cache key and request context, so one auth strategy can safely
cache per org/profile. In a khotan app, adapt `khotanData.cache(...)` with
`tokenCacheStore`.

```typescript
const oauthTokens = khotanData.cache("oauth-tokens");

const auth = tokenExchange({
  // ...
  cacheKey: (vars, ctx) =>
    `${ctx.plugName}:${ctx.profile ?? "default"}:${vars.orgId}`,
  tokenStore: tokenCacheStore(oauthTokens, { prefix: "fresh:" }),
});
```

`tokenStore` can also be implemented directly:

```typescript
const auth = tokenExchange({
  // ...
  tokenStore: {
    get: (key) => oauthTokens.get(key ?? "default"),
    set: (token, key) => oauthTokens.set(key ?? "default", token),
    clear: (key) => oauthTokens.delete(key ?? "default"),
  },
});
```

`tokenExchange` resolves vars as `{ ...getVariables?.(), ...requestVars }`.
Factory-bound request vars override env defaults. `buildTokenRequest`,
`parseTokenResponse`, `extraHeaders`, `cacheKey`, and `tokenStore` receive the
same request context (`url`, `method`, `body`, `plugName`, `profile/target`).

### HMAC Signature Example

```typescript
const auth = hmacSignature({
  algorithm: "sha256",
  header: "api-auth-signature",
  sign: ({ method, url, query, body, vars }) =>
    hmacSha256(vars.apiSecret, [
      method,
      new URL(url).pathname,
      query,
      JSON.stringify(body ?? ""),
    ].join("\n")),
});
```

### Authorization Code + PKCE Example

```typescript
const graphAuth = authorizationCode({
  authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  clientId: process.env.MS_GRAPH_CLIENT_ID!,
  redirectUri: process.env.MS_GRAPH_REDIRECT_URI!,
  scopes: ["offline_access", "User.Read"],
  pkce: true,
  tokenStore: {
    get: () => khotanCache.get("graph:oauth-token"),
    set: (token) => khotanCache.set("graph:oauth-token", token),
    clear: () => khotanCache.delete("graph:oauth-token"),
  },
});

const { url, codeVerifier } = await graphAuth.getAuthorizationUrl({
  state: crypto.randomUUID(),
});
// Redirect the user to url, store codeVerifier with the state, then:
await graphAuth.exchangeCode(callbackCode, { codeVerifier });
```

If a provider requires `redirect_uri` on refresh-token requests, set
`includeRedirectUriOnRefresh: true`; it resolves from the same vars used by the
request that triggered the refresh.

## Vars (Runtime Variables)

For variables managed via the Hub UI instead of env vars:

```typescript
export const myPlug = plug({
  baseUrl: "https://api.example.com",
  auth: bearer(() => ""), // overridden by vars
  vars: [
    { key: "apiKey", label: "API Key", type: "text", secret: true },
    { key: "orgId", label: "Org ID", type: "text", defaultValue: "org_demo" },
    { key: "_token", label: "", type: "text", hidden: true },
  ] as const,
});
```

Vars are encrypted in the database via `KHOTAN_SECRET` and injected per-request. Hidden vars (prefixed `_`) are internal storage (cached tokens, etc). `defaultValue` seeds the database the first time the plug is initialized, and later Hub/CLI edits override that stored value.

### Var Profiles / Targets

Register named profiles when credentials or base URLs differ by UAT/live,
tenant, or organization:

```typescript
{
  name: "packiyo",
  plug: packiyoPlug,
  profiles: {
    uat: { vars: { baseUrl: "https://uat.packiyo.example" } },
    live: { vars: { baseUrl: "https://api.packiyo.example" } },
  },
  defaultProfile: "live",
}
```

Select a profile for a run:

```typescript
await khotanData.flow("products-relay", { plugName: "packiyo" }).start({
  target: "uat", // alias for profile; applies to relay destination plugs too
});
```

Inside durable workflows, bind another plug/profile explicitly:

```typescript
const uatFresh = bindWorkflowPlug(freshPlug, ctx, {
  plugName: "fresh",
  profile: "uat",
});
```

Manage profile-specific vars through the existing CLI:

```bash
npx khotan-data plug vars packiyo set --profile uat --json '{"apiKey":"..."}'
npx khotan-data plug vars packiyo show --target live
```

## Typed Endpoints

Define Zod schemas inline on the plug:

```typescript
import { z } from "zod";

export const myPlug = plug({
  baseUrl: "https://api.example.com",
  auth: bearer(process.env.API_KEY!),
  endpoints: {
    listProducts: {
      method: "GET",
      path: "/products",
      query: z.object({ page: z.number().optional(), limit: z.number().optional() }),
      responses: { 200: z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })), total: z.number() }) },
    },
    createProduct: {
      method: "POST",
      path: "/products",
      body: z.object({ name: z.string(), price: z.number() }),
      responses: { 201: z.object({ id: z.string() }) },
    },
  },
});
```

Endpoints power the plug debugger UI, `khotan-data plug --compare`, and typed clients.

## Preferred Pattern

Keep each integration in a single app-owned plug file when possible:

```typescript
import { z } from "zod";
import { plug, basic } from "./plug";

const ProductSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
});

export type Product = z.infer<typeof ProductSchema>;

export const myPlug = plug({
  name: "my-service",
  baseUrl: "https://api.example.com",
  auth: basic(process.env.API_USER!, process.env.API_KEY!),
  endpoints: {
    listProducts: {
      method: "GET",
      path: "/products",
      query: z.object({ page: z.number().optional(), limit: z.number().optional() }),
      responses: { 200: z.array(ProductSchema) },
    },
  },
});
```

This keeps the runtime plug, debugger metadata, `khotan-data plug --compare`, and any exported types in one place.

## Hooks

```typescript
const myPlug = plug({
  // ...
  hooks: {
    beforeRequest: async (ctx) => {
      // ctx.vars, ctx.setVars, ctx.headers, ctx.url
    },
    afterResponse: async (response, ctx) => {
      // inspect/transform response
    },
  },
});
```

## Registering in Factory

In `{outputDir}/khotan.ts`:

```typescript
plugs: [
  {
    name: "stripe",
    plug: stripePlug,
    flows: [
      { name: "charges-inflow", type: "inflow", schedule: "0 * * * *", resource: "orders" },
    ],
    // Optional: wires, catches, passes
  },
],
```

## Making Requests

```typescript
// Direct
const products = await myPlug.get("/products", { params: { limit: "10" } });
const created = await myPlug.post("/products", { body: { name: "Widget" } });

// With vars (factory injects these automatically in wire/debug contexts)
const data = await myPlug.get("/items", { vars: { apiKey: "..." } });
```

## Body-Level Throttles

Some APIs return HTTP 200 with a body that means "slow down". Add `shouldRetry(response, body)` to reuse the normal retry attempts and backoff settings for those cases.

```typescript
const shopify = plug({
  baseUrl: "https://example.myshopify.com/admin/api/2025-01",
  retry: { attempts: 5, backoff: 500 },
  shouldRetry: (_response, body) => {
    const throttle = (body as {
      extensions?: {
        cost?: { throttleStatus?: { currentlyAvailable?: number } };
      };
    }).extensions?.cost?.throttleStatus?.currentlyAvailable;
    return throttle !== undefined && throttle < 50;
  },
});
```

## Debugging

Use `khotan-data plug` to test plugs against the running dev server. `khotan-data probe` remains as a legacy alias:

```bash
npx khotan-data plug myPlug --info                    # See endpoints
npx khotan-data plug myPlug GET /products             # Fire request
npx khotan-data plug myPlug --endpoint listProducts --compare  # Check schema
```

Set `KHOTAN_DEBUG=1` for verbose `[khotan:auth]` and `[khotan:request]` console logs.

### Recommended Plug Workflow

1. Create the plug file and auth/hook setup.
2. Add a small set of typed endpoints directly on the plug (`listProducts`, `getProduct`, etc).
3. Run the app with `KHOTAN_DEBUG=1`.
4. Use `npx khotan-data plug myPlug --info` to confirm the endpoints are visible to the debugger.
5. Use `npx khotan-data plug myPlug --endpoint listProducts --compare` against the live API.
6. Tighten schemas until the compare output matches the real payload shape you care about.
7. Only then build inflows, relays, outflows, or webhook handlers on top of those endpoints.

The package does not paginate or delta-sync for you automatically inside user flows. Your app code decides which typed endpoints to call, what page size to use, when to stop, and how to implement full, test, partial, backfill, reconcile, or delta runs.

## Managing Vars

Use the CLI to inspect and update stored plug variables:

```bash
npx khotan-data plug vars --list
npx khotan-data plug vars myPlug
npx khotan-data plug vars myPlug set --json '{"apiKey":"secret","orgId":"org_live"}'
npx khotan-data plug vars myPlug set --profile uat --json '{"apiKey":"secret","orgId":"org_uat"}'
npx khotan-data plug vars myPlug clear
```

Variable reads mask `secret` fields automatically. Hub and CLI both talk to the same `/api/khotan/variables/*` routes.
