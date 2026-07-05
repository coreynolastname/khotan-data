## Purpose

The Hub provides a visual dashboard for monitoring khotan plugs and flows. It consists of scaffolded React components and API route templates that the user owns and can customize.

## Requirements

### Requirement: Hub CLI component
The CLI SHALL provide a `hub` component that scaffolds multiple files when the user runs `npx khotan add hub`.

#### Scenario: Scaffold hub component
- **WHEN** a user runs `npx khotan add hub` in a project with a valid `khotan.config.ts`
- **THEN** the CLI SHALL create `components/khotan/hub.tsx` relative to the project root
- **AND** the CLI SHALL create `app/api/khotan/[...all]/route.ts` (or `src/app/api/khotan/[...all]/route.ts` if the project uses `src/app`)
- **AND** the CLI SHALL create `<outputDir>/khotan.ts` (the user's khotan config file)
- **AND** the CLI SHALL print a success message listing all created files

#### Scenario: Scaffold hub when shadcn is not configured
- **WHEN** a user runs `npx khotan add hub` and no `components.json` (shadcn config) exists
- **THEN** the CLI SHALL print a warning that shadcn/ui is required for the Hub component
- **AND** the CLI SHALL print instructions to run shadcn init first

#### Scenario: Hub files already exist
- **WHEN** a user runs `npx khotan add hub` and any of the target files already exist
- **THEN** the CLI SHALL prompt the user to confirm overwrite for each existing file (or use `--force` to skip prompts)

### Requirement: Hub React component
The scaffolded `hub.tsx` SHALL be a React client component that displays configured plugs and their flows. It SHALL use shadcn/ui primitives (Card, Badge, Table, Switch) for styling.

#### Scenario: Display plugs list
- **WHEN** the Hub component is rendered
- **THEN** it SHALL fetch plugs from `GET /api/khotan/plugs`
- **AND** it SHALL display each plug as a card with the plug name, base URL, auth type, status, and enabled state

#### Scenario: Display flows for a plug
- **WHEN** a user views a plug in the Hub
- **THEN** the Hub SHALL show the plug's associated flows with their name, type, schedule, last run status, and enabled state

#### Scenario: Display persisted run updates
- **WHEN** a user opens a completed run with persisted `sendUpdate()` history
- **THEN** the Hub SHALL fetch `GET /api/khotan/runs/:id/stream`
- **AND** it SHALL render replayed update messages with metadata and counters for debugging

#### Scenario: Display empty state
- **WHEN** no plugs are registered
- **THEN** the Hub SHALL display a helpful empty state message explaining how to register plugs in the khotan config file

#### Scenario: Display error state
- **WHEN** the API request fails
- **THEN** the Hub SHALL display an error message with a retry option

#### Scenario: Loading state
- **WHEN** the Hub is fetching data
- **THEN** it SHALL display a loading skeleton or spinner

### Requirement: Hub API route template
The scaffolded `app/api/khotan/[...all]/route.ts` SHALL import the user's khotan config and export Next.js route handlers.

#### Scenario: Route file structure
- **WHEN** the route file is scaffolded
- **THEN** it SHALL import `khotanData` from the user's config file (e.g., `@/lib/khotan/khotan`)
- **AND** it SHALL import `toNextJsHandler` from `khotan-data/factory`
- **AND** it SHALL export `const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(khotanData.handler)`

### Requirement: Hub config template
The scaffolded `<outputDir>/khotan.ts` SHALL be a config file where the user registers their plugs and flows with the `khotan()` factory.

#### Scenario: Config file structure
- **WHEN** the config file is scaffolded
- **THEN** it SHALL import `khotan` and `drizzleAdapter` from `khotan-data/factory`
- **AND** it SHALL include a placeholder import for the user's Drizzle database instance
- **AND** it SHALL include an example plug registration with comments
- **AND** it SHALL export the khotan instance as the default export

#### Scenario: Config file is editable
- **WHEN** the user edits the config file to add their own plugs
- **THEN** the file SHALL compile without errors as valid TypeScript
- **AND** the registered plugs SHALL appear in the Hub after server restart

### Requirement: Hub component is self-contained
The scaffolded `hub.tsx` SHALL NOT import from `khotan-data`. It SHALL only import from React, shadcn/ui components, and standard browser APIs (fetch).

#### Scenario: No khotan-data runtime dependency
- **WHEN** the hub.tsx file is inspected
- **THEN** it SHALL contain zero import statements referencing `khotan-data`

### Requirement: Hub fetches from hardcoded API path
The Hub component SHALL fetch data from `/api/khotan/*` endpoints. The API path SHALL be hardcoded in the component.

#### Scenario: API requests use correct paths
- **WHEN** the Hub fetches plugs
- **THEN** it SHALL request `GET /api/khotan/plugs`
