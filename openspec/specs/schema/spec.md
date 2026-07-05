## Purpose

The khotan schema component provides Drizzle ORM table definitions for plugs, flows, and runs — the data layer backing the Hub UI and flow components. Scaffolded via `npx khotan add schema`, the file is self-contained and user-owned.

## Requirements

### Requirement: khotan_plugs table
The schema SHALL define a `khotan_plugs` Drizzle table with the following columns: `id` (text, primary key, default UUID), `name` (text, unique, not null), `base_url` (text, not null), `auth_type` (text, not null — one of 'bearer', 'basic', 'apiKey', 'custom'), `enabled` (boolean, default true), `status` (text, default 'idle' — one of 'connected', 'error', 'idle'), `status_message` (text, nullable), `encrypted_vars` (text, nullable), `created_at` (timestamp with timezone, default now), `updated_at` (timestamp with timezone, default now).

#### Scenario: Table has correct columns and defaults
- **WHEN** the schema file is loaded by Drizzle
- **THEN** the `khotan_plugs` table SHALL have all specified columns with their types and defaults
- **AND** `id` SHALL auto-generate a UUID via `$defaultFn`
- **AND** `name` SHALL have a unique constraint
- **AND** `created_at` and `updated_at` SHALL default to the current timestamp

### Requirement: khotan_flows table
The schema SHALL define a `khotan_flows` Drizzle table with the following columns: `id` (text, primary key, default UUID), `plug_id` (text, not null, references khotan_plugs.id), `name` (text, not null), `type` (text, not null — one of 'inflow', 'outflow', 'relay', 'webhook'), `enabled` (boolean, default true), `schedule` (text, nullable — cron expression), `resource_id` (text, nullable, references khotan_resources.id), `last_run_at` (timestamp with timezone, nullable), `last_run_status` (text, nullable — one of 'ok', 'failed'), `created_at` (timestamp with timezone, default now), `updated_at` (timestamp with timezone, default now).

#### Scenario: Table has foreign key to plugs
- **WHEN** the schema file is loaded by Drizzle
- **THEN** `plug_id` SHALL reference `khotan_plugs.id`
- **AND** the table SHALL have a unique constraint on `(plug_id, name)`

#### Scenario: Table has optional foreign key to resources
- **WHEN** the schema file is loaded by Drizzle
- **THEN** `resource_id` SHALL reference `khotan_resources.id`
- **AND** `resource_id` SHALL be nullable

#### Scenario: Flow types are constrained
- **WHEN** a row is inserted into `khotan_flows`
- **THEN** the `type` column SHALL accept 'inflow', 'outflow', 'relay', or 'webhook'

### Requirement: khotan_runs table
The schema SHALL define a `khotan_runs` Drizzle table with the following columns: `id` (text, primary key, default UUID), `flow_id` (text, **nullable**, references khotan_flows.id), `wire_id` (text, **nullable**, references khotan_wires.id), `run_type` (text, not null — one of 'full', 'delta', 'backfill', 'reconcile', 'dry-run', 'webhook'), `status` (text, not null, default 'pending' — one of 'pending', 'running', 'ok', 'failed'), `started_at` (timestamp with timezone, default now), `completed_at` (timestamp with timezone, nullable), `duration_ms` (integer, nullable), `extracted` (integer, default 0), `transformed` (integer, default 0), `created` (integer, default 0), `updated` (integer, default 0), `deleted` (integer, default 0), `failed` (integer, default 0), `error` (text, nullable), `metadata` (jsonb, nullable).

#### Scenario: Table has optional foreign key to flows
- **WHEN** the schema file is loaded by Drizzle
- **THEN** `flow_id` SHALL be nullable and reference `khotan_flows.id`

#### Scenario: Table has optional foreign key to wires
- **WHEN** the schema file is loaded by Drizzle
- **THEN** `wire_id` SHALL be nullable and reference `khotan_wires.id`

#### Scenario: Run references either flow, wire, or webhook handler
- **WHEN** a row is inserted into `khotan_runs`
- **THEN** the row MAY reference a flow, wire, or webhook handler depending on run source

#### Scenario: Run counters default to zero
- **WHEN** a row is inserted with only required fields
- **THEN** `extracted`, `transformed`, `created`, `updated`, `deleted`, and `failed` SHALL all default to 0

### Requirement: khotan_run_updates table
The schema SHALL define a `khotan_run_updates` Drizzle table for persisted `sendUpdate()` history with `run_id`, `index`, `timestamp`, `namespace`, `type`, `message`, `metadata`, and `counters` columns.

#### Scenario: Run updates are ordered per run
- **WHEN** multiple updates are persisted for a run
- **THEN** each update SHALL have a monotonically increasing `index` scoped to that `run_id`
- **AND** `(run_id, index)` SHALL uniquely identify an update

#### Scenario: Run updates retain debugging payloads
- **WHEN** application code emits a run update with metadata and counters
- **THEN** the schema SHALL store `metadata` as JSONB and `counters` as JSONB so completed-run debugging can replay the emitted details

### Requirement: Schema exports Drizzle relations
The schema file SHALL export Drizzle `relations` definitions for all tables so that relational queries work (e.g., querying a plug with its flows and runs, querying a wire with its runs, a resource with its flows and mappings).

#### Scenario: Plug has many flows
- **WHEN** a relational query fetches a plug with its flows
- **THEN** the relation SHALL return all flows where `plug_id` matches the plug's `id`

#### Scenario: Plug has many wires
- **WHEN** a relational query fetches a plug with its wires
- **THEN** the relation SHALL return all wires where `plug_id` matches the plug's `id`

#### Scenario: Flow has many runs
- **WHEN** a relational query fetches a flow with its runs
- **THEN** the relation SHALL return all runs where `flow_id` matches the flow's `id`

#### Scenario: Wire has many runs
- **WHEN** a relational query fetches a wire with its runs
- **THEN** the relation SHALL return all runs where `wire_id` matches the wire's `id`

#### Scenario: Flow belongs to optional resource
- **WHEN** a relational query fetches a flow with its resource
- **THEN** the relation SHALL return the resource where `id` matches the flow's `resource_id`, or null if `resource_id` is null

#### Scenario: Resource has many flows
- **WHEN** a relational query fetches a resource with its flows
- **THEN** the relation SHALL return all flows where `resource_id` matches the resource's `id`

#### Scenario: Resource has many mappings
- **WHEN** a relational query fetches a resource with its mappings
- **THEN** the relation SHALL return all mappings where `resource_id` matches the resource's `id`

### Requirement: Schema includes indexes
The schema file SHALL define indexes for common query patterns: flows by plug_id, flows by resource_id, runs by flow_id, runs by wire_id, runs by status, runs by started_at (descending), wires by plug_id, wires by status, mappings by resource_id, and a GIN index on mappings refs.

#### Scenario: Query flows by resource efficiently
- **WHEN** the database is queried for all flows of a resource
- **THEN** an index on `resource_id` SHALL be available to optimize the query

#### Scenario: Query recent runs efficiently
- **WHEN** the database is queried for the 10 most recent runs of a flow
- **THEN** an index on `(flow_id, started_at DESC)` SHALL be available to optimize the query

#### Scenario: Query mappings by refs content
- **WHEN** the database is queried for a mapping by a specific ref value
- **THEN** a GIN index on `refs` SHALL be available to optimize the query

#### Scenario: Query wires by plug efficiently
- **WHEN** the database is queried for all wires of a plug
- **THEN** an index on `plug_id` SHALL be available to optimize the query

#### Scenario: Query runs by wire efficiently
- **WHEN** the database is queried for all runs triggered by a wire
- **THEN** an index on `wire_id` SHALL be available to optimize the query

### Requirement: Schema is self-contained
The schema file SHALL import only from `drizzle-orm/pg-core` and `drizzle-orm`. It SHALL NOT import from `khotan-data` or any other package beyond `drizzle-orm`.

#### Scenario: No khotan-data runtime dependency
- **WHEN** the schema file is inspected
- **THEN** it SHALL contain zero import statements referencing `khotan-data`

### Requirement: Schema exports type helpers
The schema file SHALL export TypeScript type helpers derived from all tables: `KhotanPlug`, `NewKhotanPlug`, `KhotanFlow`, `NewKhotanFlow`, `KhotanRun`, `NewKhotanRun`, `KhotanResource`, `NewKhotanResource`, `KhotanMapping`, `NewKhotanMapping`, `KhotanWire`, `NewKhotanWire` using Drizzle's `$inferSelect` and `$inferInsert`.

#### Scenario: Types are available for application code
- **WHEN** the user imports `KhotanResource` from the schema file
- **THEN** it SHALL be typed as the select type of the `khotan_resources` table

#### Scenario: Wire types are available for application code
- **WHEN** the user imports `KhotanWire` from the schema file
- **THEN** it SHALL be typed as the select type of the `khotan_wires` table

### Requirement: khotan_wires table
The schema SHALL define a `khotan_wires` Drizzle table with the following columns: `id` (text, primary key, default UUID), `plug_id` (text, not null, references khotan_plugs.id), `remote_id` (text, not null — the subscription ID on the external service), `callback_url` (text, not null — the URL events are sent to), `event_types` (jsonb, not null — array of subscribed event type strings), `status` (text, not null, default 'active' — one of 'active', 'disabled'), `metadata` (jsonb, nullable), `created_at` (timestamp with timezone, default now), `updated_at` (timestamp with timezone, default now).

Note: The factory's internal schema mirror adds a "pending" status to the enum and defaults to "pending" for its 2-step lifecycle (create row → subscribe → update to active). The user-facing template schema uses only "active" and "disabled" since the factory handles the transitional state internally.

#### Scenario: Table has correct columns and defaults
- **WHEN** the schema file is loaded by Drizzle
- **THEN** the `khotan_wires` table SHALL have all specified columns with their types and defaults
- **AND** `id` SHALL auto-generate a UUID via `$defaultFn`
- **AND** `status` SHALL default to 'active'
- **AND** `created_at` and `updated_at` SHALL default to the current timestamp

#### Scenario: Table has foreign key to plugs
- **WHEN** the schema file is loaded by Drizzle
- **THEN** `plug_id` SHALL reference `khotan_plugs.id`

#### Scenario: Table has indexes
- **WHEN** the schema file is loaded by Drizzle
- **THEN** there SHALL be an index on `plug_id`
- **AND** there SHALL be an index on `status`

### Requirement: khotan_caches table
The schema SHALL define a `khotan_caches` Drizzle table for registered cache definitions. The table SHALL include `id` (text, primary key, default UUID), `name` (text, unique, not null), `scope` (jsonb, nullable), `ttl_seconds` (integer, nullable), `created_at` (timestamp with timezone, default now), and `updated_at` (timestamp with timezone, default now).

#### Scenario: Cache definitions have stable identity
- **WHEN** the schema file is loaded by Drizzle
- **THEN** the `khotan_caches` table SHALL expose a unique constraint on `name`
- **AND** it SHALL generate default UUID primary keys

#### Scenario: Cache definitions store scope metadata
- **WHEN** a cache definition includes scope metadata
- **THEN** the schema SHALL persist that scope in the `scope` column

### Requirement: khotan_cache_entries table
The schema SHALL define a `khotan_cache_entries` Drizzle table for durable cache values. The table SHALL include `id` (text, primary key, default UUID), `cache_id` (text, not null, references `khotan_caches.id`), `key` (text, not null), `value` (jsonb, not null), `expires_at` (timestamp with timezone, nullable), `created_at` (timestamp with timezone, default now), and `updated_at` (timestamp with timezone, default now).

#### Scenario: Cache entry uniqueness is per cache and key
- **WHEN** the schema file is loaded by Drizzle
- **THEN** the `khotan_cache_entries` table SHALL enforce a unique constraint on `(cache_id, key)`

#### Scenario: Cache entries support expiry metadata
- **WHEN** a cache entry is written with a computed expiry
- **THEN** the schema SHALL persist that expiry in `expires_at`

### Requirement: Schema exports cache relations and indexes
The schema SHALL export Drizzle relations and indexes for cache definitions and entries so cache lookups and browsing are efficient and typed.

#### Scenario: Cache definition has many entries
- **WHEN** a relational query fetches a cache definition with its entries
- **THEN** the relation SHALL return all cache rows where `cache_id` matches the definition's `id`

#### Scenario: Cache entry belongs to one definition
- **WHEN** a relational query fetches a cache entry with its cache definition
- **THEN** the relation SHALL return the definition where `id` matches the entry's `cache_id`

#### Scenario: Cache lookups are indexed
- **WHEN** the schema file is loaded by Drizzle
- **THEN** it SHALL define indexes supporting lookup by `cache_id`, lookup by `(cache_id, key)`, and expiry-oriented cleanup or inspection by `expires_at`

### Requirement: Schema exports cache type helpers
The schema SHALL export TypeScript type helpers for cache definitions and cache entries using Drizzle `$inferSelect` and `$inferInsert`.

#### Scenario: Cache types are available for application code
- **WHEN** a user imports cache-related types from the schema file
- **THEN** the schema SHALL provide select and insert helper types for both `khotan_caches` and `khotan_cache_entries`
