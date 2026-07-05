# Khotan Data E2E Harness

The E2E runner tests the published artifact shape, not a local source import.
It builds this package, runs `npm pack` into a temp directory, scaffolds
throwaway consumer apps from `e2e/fixtures/*`, installs the tarball into each
app, runs the real `khotan-data` binary, asserts generated files, and typechecks
the generated consumer project.

Run the default scenarios:

```bash
npm run e2e
```

The default run maps one package manager to each fixture:

| Scenario | Package manager | Coverage |
| --- | --- | --- |
| `next14-root-app-npm` | npm | Next 14 App Router with top-level `app/` |
| `next15-src-app-single-schema-config-pnpm` | pnpm | Next 15 `src/app/` and single-file Drizzle schema config |
| `next16-src-flow-app-bun` | bun | Next 16 `src/app/`, proxy detection, and Workflow config from `add inflow` |

Run one scenario and keep the temp project for inspection:

```bash
KHOTAN_E2E_SCENARIOS=next16-src-flow-app-bun KHOTAN_E2E_KEEP=1 npm run e2e
```

Run the default scenario assigned to one package manager:

```bash
KHOTAN_E2E_PACKAGE_MANAGERS=pnpm npm run e2e
```

Run every fixture against one package manager:

```bash
KHOTAN_E2E_FULL_PM_MATRIX=1 KHOTAN_E2E_PACKAGE_MANAGERS=pnpm npm run e2e
```

Run every fixture against every package manager:

```bash
KHOTAN_E2E_FULL_PM_MATRIX=1 npm run e2e
```

The pnpm scenario uses a local `pnpm` binary when present and falls back to
`npx --yes pnpm@latest`. The bun scenario requires `bun` on `PATH`.

Fixtures are deliberately small. They represent relevant consumer shapes
without committing full app lockfiles or `node_modules`:

- `next14-root-app`: Next 14 App Router with top-level `app/`.
- `next15-src-app`: Next 15 App Router with `src/app/` and an existing
  single-file Drizzle schema config.
- `next16-src-flow-app`: Next 16 App Router with `src/app/`, proxy detection,
  and a flow component that exercises Workflow `next.config.ts` integration.
