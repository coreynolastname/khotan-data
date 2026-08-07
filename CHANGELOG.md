# khotan-data

## 0.11.0

### Minor Changes

- Add fan-out relay destination support. Relays can now declare multiple destination plugs with `to: [...]`, and workflow contexts include destination refs and selected destination vars for each target.
- ff336a4: Add shared database package output options for `khotan-data generate`, including explicit schema files, schema barrels, Drizzle config targets, migrations output, and shared runtime validation hints.

## 0.10.0

### Minor Changes

- 662a76c: Expand the generated plug auth runtime with HMAC request-signing context,
  durable token-exchange storage, authorization-code PKCE helpers, and OAuth
  form-urlencoded examples.
- 98f09f9: Improve CLI setup completeness: `init` now maintains `.env.template`, `add schema` scaffolds a minimal `drizzle.config.ts` when missing and ensures `drizzle-kit` is a dev dependency, Workflow-backed components add `serverExternalPackages`, and `add cron` manages the Vercel cron dispatcher.
- b801ef2: Add CLI ops guardrails for local org pinning, database binding metadata, app env preparation, and bootstrap scaffolding. The new commands use local config/files only and document the transaction boundary for Drizzle-backed Khotan operations.
- c445333: Remove the `khotan` bin alias. The CLI is now exposed only as `khotan-data` to avoid clashing with other packages that ship a `khotan` bin. Update any scripts that invoke `khotan` to use `khotan-data`.
- a57be96: Add factory-level lifecycle hooks, stuck-run reconciliation helpers/routes, and a runtime-agnostic `khotan-data/retry` export with retry and SHA-256 dedupe helpers.
- 9b4f1a4: Export first-class scaffold builders from `khotan-data/factory`: `inflow`, `outflow`, `relay`, `catchEvent`, and `wire`. Flow contexts and `flow().start()` now accept typed body generics, and generated scaffold templates re-export the real builders instead of re-declaring local pass-through implementations.

  Add `khotan-data/next` as a compatibility Next.js App Router subpath for projects that expose the standard `@/khotan/khotan` instance. `khotan init` now scaffolds route handlers with `toNextJsHandler` and a computed relative import to the generated instance, so custom output directories work without relying on aliases.

  Hub UI remains scaffolded source in this release. Publishing `@khotan/hub` is intentionally left as a scoped packaging project because the current vendored Hub surface is large and should be split with explicit component API, peer dependency, and stylesheet contracts rather than shipped as a placeholder package.

- d1eed2b: Secure the management API by default. Omitting `authorize` now denies management requests in development and throws in production, while `authorize: false` is limited to non-production explicit opt-out. Added `khotan add auth` to scaffold Better Auth and wire the khotan authorize hook.
- af0091a: Add a typed inbound ingest builder for destination endpoints plus `khotan add ingest` scaffolding with org resolution, idempotency hooks, unresolved-intake parking guidance, and mapping helper integration.
- 1aba98a: Add webhook toolkit helpers: `verifyHmacSha256`, manual wire mode, explicit wire renewal hooks/API, and schema-typed catch events.

### Patch Changes

- c445333: Accept `--json` on the API-backed CLI read commands (`flows`, `mappings`, `plug`,
  `wire`). Their output is already JSON, so the flag is explicit/no-op, but passing
  it no longer errors with `unknown option '--json'`. (`plug vars --json <payload>`
  keeps its existing value-taking meaning.)
- 304d3ca: Add load/write-back primitives: natural-key Drizzle upserts, cache-backed delta and cursor helpers, and batched plug POSTs.
- c445333: The `logs` component now declares `lucide-react` as an npm dependency. Its
  `runs-table.tsx` imports an icon from `lucide-react`, so scaffolding `logs` into a
  fresh app previously produced code that failed to typecheck/run until the package
  was installed by hand.
- 17d58c5: Add resource-name mapping helpers with `mapping(resourceName).upsert(...)`,
  `lookup(...)`, and `lookupByRef(...)`, plus explicit `mergeRefs` control for
  partial ref merges versus full replacement.
- e909067: Expand the generated plug pagination and retry helpers with inline per-call pagination inspectors, link/JSON:API/envelope strategies, absolute next URL support, inter-page delays, and `shouldRetry(response, body)` for body-level throttles on successful HTTP responses.
- c68d754: Widen the generated factory and persisted plug auth metadata so consumers can remove scaffold workarounds. `drizzleAdapter(db)` now accepts transaction-free Drizzle database subsets without the previous `as unknown as` double-cast, and custom auth types such as `tokenExchange` are stored as-is instead of being coerced to the built-in bearer/basic/apiKey/custom set.
- 30d2df2: Flow runs now finalize reliably from returned workflow `FlowRunResult` values. Inline `run(ctx)` handlers expose `ctx.finalize(result)` as a race-idempotent escape hatch; durable workflow contexts rely on returned `FlowRunResult` values as the production-safe contract. Manual start bodies are persisted as initial run metadata and preserved unless the final result explicitly supplies metadata.
- c445333: Scaffolded and rewritten Drizzle `schema` globs now target `*.ts` only (e.g.
  `./db/schema/*.ts`) instead of `*`. This stops `drizzle-kit` from trying to parse
  non-TypeScript files such as `AGENTS.md` in the schema directory, which crashed
  `migrate` with a misleading `SyntaxError`.

## Unreleased

### Patch Changes

- Flow runs now finalize reliably from returned workflow `FlowRunResult` values
  and expose inline `run(ctx)` `ctx.finalize(result)` as a race-idempotent
  escape hatch. Durable workflow contexts rely on returned `FlowRunResult`
  values as the production-safe contract. Manual start bodies are persisted as
  initial run metadata and preserved unless the final result explicitly supplies
  metadata.

## 0.9.2

### Patch Changes

- cab03a4: Fix `khotanCache(ctx, …)` and `khotanMappings(ctx)` throwing `Khotan runtime helpers for instance "…" are not registered` inside Vercel Workflow `"use step"` functions in production.

  The factory instance id is now derived deterministically from the config's stable identity (sorted plug/flow/cache/resource names) instead of a per-process `crypto.randomUUID()`. A workflow step runs in a fresh isolate that re-imports the flow module and re-runs `khotan(config)`; deriving the id from config identity means the re-imported module lands on the same runtime-registry key, so cache/mapping helpers resolve across the isolate boundary (the same way plug vars already survive via serialized context).

  Also adds a sole-instance fallback in the registry lookup (resolve to the only registered instance on a miss) and a clearer error when multiple instances are registered and none match.

## 0.9.0

### Minor Changes

- a5366a2: feat(cli): add `init --skills-only` to install agent skills without scaffolding core files

  `npx khotan init --skills-only` installs only the agent skill set, skipping `khotan.config.ts`, the `khotan.ts` factory, the catch-all route, and the package install. Useful in polyrepo setups where the khotan-data runtime lives elsewhere and a separate location only hosts the skills. The flag is mutually exclusive with `--full`.

- c3e2720: feat(plug): form-encoded token bodies, vars-aware auth, and per-environment baseUrl

  Three improvements to the generated `plug.ts` client, addressing connector friction:
  - **`tokenExchange` honors pre-encoded token bodies.** A `string` or `URLSearchParams` body from `buildTokenRequest` is now sent verbatim with the `Content-Type` you set, so OAuth2 endpoints requiring `application/x-www-form-urlencoded` (`grant_type=client_credentials`) work without hand-rolling an `AuthStrategy`. Plain object bodies are still JSON-encoded as before.
  - **Auth strategies receive the plug's bound vars.** `AuthStrategy.apply(headers, vars?)` and `custom((headers, vars) => …)` now get the decrypted plug variables for the run, so a custom strategy can read credentials without lazy-importing the factory.
  - **`baseUrl` can be a function of vars.** Pass `baseUrl: (vars) => …` for per-environment / per-tenant hosts resolved at request time. Because the debug/probe route binds the same vars, it targets the same host a flow would — closing the probe/flow divergence. A static `string` baseUrl is unchanged.

- 4be27ec: feat(flows): add a `skipped` counter to flow run results, and allow a request body on plug `delete`

  Flow runs now track a `skipped` counter alongside created/updated/deleted/failed, giving delta-sync's most common outcome (records unchanged) a home; it threads through `FlowRunResult`, the `khotan_runs` table, `RunSummary`, the adapter, and the Slack notifier payload, and is treated as a neutral outcome that never drives partial/failed status. Bound plugs may now pass a request `body` on `delete`, unblocking batch soft-delete via `DELETE` (the plug template already forwarded it — only the type signatures forbade it).

### Patch Changes

- 13f67f5: docs(skill-frontend): document Hub `webhookUrl` prop and the Plug Debugger debug HTTP API

  Folds two previously-undocumented reference facts into the generated `khotan-frontend` skill so it stays the single source of truth for the UI surface: the optional `<KhotanHub webhookUrl="..." />` prop, and the `GET/POST /api/khotan/debug[/:plugName]` endpoints used by the plug debugger. Lets downstream starters drop forked `khotan-dashboard` skills without losing reference detail.

- fix(cli): honor `--port` on the `khotan plug vars` subcommand

  `khotan plug vars <plug> --port N` (and `khotan plug --port N vars …`) ignored the flag and fell back to port 3000, because commander binds `--port` to whichever of the parent `plug` / child `vars` command parses it while the `vars` action only read its own `opts.port`. The action now uses `optsWithGlobals()`, so the flag is honored in either position.

- d5ac73f: fix(scaffold): generated example files compile and lint clean out of the box

  `relay.example.ts` called `cache.set(key, value, { ttl })` with a third argument the `CacheInstance.set` signature doesn't accept (TTL is configured on the cache definition, not per call), so the scaffolded file failed `tsc`. Removed the stray argument. Also dropped an unused `eslint-disable` directive in the `plug.ts` template, and corrected the stale `start({ runType })` example in the README to `start({ variant })`.

## 0.8.0

### Minor Changes

- 2c6d788: Add flow variants: named run modes with per-variant schedules and lifecycle hooks.

  A flow may now declare a `variants` map (`{ schedule?, onError?, onComplete? }`),
  where the variant **name** is the run mode. Flow code branches on `ctx.variant`
  (e.g. `"delta"`, `"full"`, `"healthcheck"`). The cron dispatcher schedules each
  flow × variant by that variant's `schedule`; variants without a schedule are
  manual-only. Per-variant `onError`/`onComplete` hooks fire on terminal run
  states, with a batteries-included `slackNotifier(webhookUrl)` helper exported
  from `khotan-data/factory`.

  Triggering selects a variant: `flow(name).start({ variant })`, the flow-run API
  body `{ variant }`, and the CLI (`khotan flows trigger <flow> <variant>` or
  `--variant`).

  **BREAKING — `runType` → `variant`:**
  - `ctx.runType` is removed from the flow run context; use `ctx.variant`.
  - `--run-type` (CLI) and `{ runType }` (API / `start`) are accepted as
    **deprecated aliases** that map to `variant` for one minor release.
  - The `khotan_runs.run_type` enum column is replaced by `variant` (text — the
    run mode) plus `source` (text — `scheduled` | `manual` | `webhook`).

  **Migration.** Consumers run `npx khotan migrate` (or `--push`). The new
  `variant` column ships with a server default (`'default'`) so the generated
  `ADD COLUMN ... NOT NULL` applies safely to tables with existing rows. The
  auto-generated migration is crash-safe, but it backfills old rows with
  `'default'`/`'manual'` rather than their original `run_type`. To preserve the
  exact historical run modes, apply this data-preserving SQL instead:

  ```sql
  ALTER TABLE "khotan_runs" ADD COLUMN "variant" text;
  ALTER TABLE "khotan_runs" ADD COLUMN "source" text NOT NULL DEFAULT 'manual';
  UPDATE "khotan_runs" SET "variant" = "run_type";
  UPDATE "khotan_runs" SET "source" = CASE WHEN "run_type" = 'webhook' THEN 'webhook' ELSE 'scheduled' END;
  ALTER TABLE "khotan_runs" ALTER COLUMN "variant" SET NOT NULL;
  ALTER TABLE "khotan_runs" DROP COLUMN "run_type";
  ```

  A flow that declares no `variants` keeps working unchanged: it is normalized to a
  single implicit `default` variant carrying the top-level `schedule`, so
  `ctx.variant === "default"`.

## 0.7.0

### Minor Changes

- 7f4d79d: Add per-run flow variants: trigger a flow with `--variant <name>` (or `variant`
  in the start/request body) and branch extract/transform/load logic on
  `ctx.variant`. Plumbed through `FlowWorkflowContext`, `FlowRunContext`, and
  `FlowStartOptions`.

  Scaffold a Drizzle config and `db` instance in `npx khotan init --full` so the
  factory's `@/db` import resolves and `migrate` works out of the box.

  Harden `npx khotan add` for non-interactive use: it no longer hangs on overwrite
  prompts when stdin is not a TTY, and `add schema` falls back to a conventional
  `db/schema` directory instead of colliding with the factory config `khotan.ts`.

## 0.6.0

### Minor Changes

- 27c8727: Restructure the agent skills around a `khotan-build` orchestrator that drives the end-to-end integration workflow with explicit consent gates (scope, mutation, flows/webhooks, frontend). Add `khotan-flow`, `khotan-cache`, and `khotan-mappings`; rename `khotan-dashboard` to `khotan-frontend` (suggest-only — never adds UI or routes without confirmation); and harden the setup, plug, probe, and webhook skills.

## 0.5.0

### Minor Changes

- Harden CLI, templates, and published primitives (Group 3)
  - Extract shared CLI utilities into `cli-api.ts` (kill copy-paste across probe/wire/flows/mappings/vars)
  - Unify `outputDir` resolution with a single `resolveOutputDir()` used everywhere
  - Make `generate` non-destructive (requires `--force` to overwrite)
  - Fix `--yes`/`--force` semantics: `--yes` = non-interactive, `--force` = overwrite
  - Redact secrets in `probe vars` output by default (add `--show-secrets`)
  - Fix corrupted plug template header and remove dead `khotan-route.ts`
  - Correct probe connectivity checks per operation (`/plugs` for list, `/debug` for debug)
  - Agent-skill installer: version stamps, refresh-on-upgrade, multi-agent link rewriting
  - Pipeline builder: `run()` rejects on error by default, `step:start` once per step, cancellation support with `result.cancelled` flag
  - Safer regex mutations in next-config and drizzle-detect (non-greedy, verify match before write)
  - `isScaffolded` requires all files present for multi-file components
  - Docs alignment (README + skill templates)

## 0.4.1

### Patch Changes

- Replace the positional segment router (`segments.indexOf(...)`) with a declarative route table. Routes are now `{ method, pattern, auth, handler }` entries matched against named params (`:plugName`, `:flowId`, etc.), eliminating collision-prone `indexOf` checks where a cache key or mapping value named `plugs` could mis-route.

- Centralize the auth gate as route metadata. Each route declares its auth type (`authorize`, `webhook`, `cron`, `debug`) instead of scattered positional `isInboundWebhook`/`isCronRoute`/`isDebugRoute` checks.

- De-duplicate the catch/pass webhook processing loops into a single `processWebhookHandler()` function, removing ~150 lines of near-identical code.

- Extract a `readEncryptedJson()` helper that consolidates the "decrypt → fallback to plain JSON → fallback to `{}`" pattern previously copy-pasted across `getWireVars`, the webhook handler, and `getStoredVarsByPlugId`.

- Webhook processing now uses `waitUntil()` from `@vercel/functions` when available, ensuring work reliably completes after the `202` response on serverless runtimes instead of a floating `void Promise.resolve().then(...)`.

- Add `dispose()` to `KhotanInstance` to remove the instance from the module-level runtime registry, preventing unbounded growth in tests, HMR, or multi-instance scenarios.

- Require explicit security posture for `authorize`: omitting the field in production (`NODE_ENV=production`) throws. In current versions, omitting it in development warns and default-denies management routes with `401`; `authorize: false` is an explicit non-production opt-out for publicly accessible management routes.

- Remove dual-casing fallback in `getRunWorkflowId` — only `workflowRunId` (camelCase) is checked, matching Drizzle's mapped column names.

- Add integration test suite (`integration/router.test.ts`) for live E2E testing against brs-khotan-connector. Run manually with `npm run test:integration`.

## 0.4.0

### Minor Changes

- Decompose the `factory.ts` monolith into focused, individually-testable modules (`schema`, `crypto`, `cli-auth`, `cron`, `zod-introspect`, `types`, `drizzle-adapter`, `runtime`, `workflow`, `helpers`, `debug`) behind a thin `factory.ts` entry that re-exports the same public surface. Behavior-preserving; additionally exports the `KhotanWorkflowContextRef` and `KhotanWorkflowRuntimeHelpers` types.

  The cron route is now a heartbeat: it evaluates all scheduled flows and triggers any that are due or overdue based on their schedule and last run, catching up missed runs, instead of firing only when the current minute matches the cron expression.

- d3ce01d: Add a `khotan-data` bin alias to disambiguate from `@khotan/cli`.

  Both packages declare a bin named `khotan`, so a project that depends on both
  can only link one `node_modules/.bin/khotan`, making `npx khotan` resolve
  nondeterministically. khotan-data now also exposes a `khotan-data` bin (the
  existing `khotan` bin is unchanged), giving the ETL CLI an unambiguous
  invocation. Help/usage text reflects whichever bin was used and defaults to
  `khotan-data`.
