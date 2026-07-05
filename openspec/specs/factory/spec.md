## Purpose

The khotan factory provides the runtime engine for khotan-data — a `khotan()` factory function that accepts a database adapter and plug registrations, upserts them on initialization, and exposes an API handler for querying plugs, flows, and runs.

## Requirements

### Requirement: khotan factory function
The `khotan-data` package SHALL export a `khotan()` factory function from `khotan-data/factory` that accepts a configuration object with `adapter` (database adapter) and `plugs` (array of plug registrations). It SHALL return an object with a `handler` property and an `init()` method.

#### Scenario: Create a khotan instance
- **WHEN** a user calls `khotan({ adapter: drizzleAdapter(db), plugs: [...] })`
- **THEN** the function SHALL return an object with `handler` and `init` properties
- **AND** the function SHALL NOT perform any database operations until `init()` is called or the first handler request is received

#### Scenario: Khotan with no plugs
- **WHEN** a user calls `khotan({ adapter: drizzleAdapter(db), plugs: [] })`
- **THEN** the factory SHALL return a valid instance with an empty registration set
- **AND** the handler SHALL still respond to API requests (returning empty lists)

### Requirement: Plug registration
Each plug registration SHALL be an object with `name` (string, unique identifier), `baseUrl` (string), `authType` (string — one of 'bearer', 'basic', 'apiKey', 'custom'), and optional `flows` (array of flow registrations). Each flow registration SHALL have `name` (string), `type` (string — one of 'inflow', 'outflow', 'relay', 'webhook'), optional `schedule` (string, cron expression), optional `resource` (string — name of a registered resource this flow feeds), optional `to` (destination plug/system name for relay flows), optional `workflow` (Vercel Workflow execution function), and optional `run` (inline/manual execution function).

#### Scenario: Register a plug with flows
- **WHEN** a user registers a plug `{ name: "stripe", baseUrl: "https://api.stripe.com", authType: "bearer", flows: [{ name: "products-inflow", type: "inflow", schedule: "0 * * * *" }] }`
- **THEN** the factory SHALL accept this configuration for database upsert

#### Scenario: Register a plug with flows that reference resources
- **WHEN** a user registers a plug `{ name: "shopify", baseUrl: "https://...", authType: "bearer", flows: [{ name: "products-inflow", type: "inflow", resource: "products" }] }`
- **THEN** the factory SHALL accept this configuration and link the flow to the "products" resource on init

#### Scenario: Flow references unknown resource
- **WHEN** a flow registration includes `resource: "products"` but no resource named "products" exists in the `resources` config array
- **THEN** the factory SHALL throw an error at configuration time

#### Scenario: Plug name uniqueness
- **WHEN** two plugs are registered with the same `name`
- **THEN** the factory SHALL throw an error at configuration time (before any database operation)

### Requirement: Database upsert on initialization
When `init()` is called (or on first handler request), the factory SHALL upsert all registered resources into `khotan_resources`, then upsert all registered plugs into `khotan_plugs`, and then upsert their flows into `khotan_flows` with resolved `resource_id` values. Upsert SHALL use the resource `name` as the conflict key for resources, the plug `name` for plugs, and `(plug_id, name)` for flows.

#### Scenario: First initialization upserts rows including resources
- **WHEN** `init()` is called with registered resources, plugs, and flows
- **THEN** the factory SHALL insert or update resource rows first
- **AND** then insert or update plug rows
- **AND** then insert or update flow rows with resolved `resource_id` values

#### Scenario: Idempotent upsert on restart
- **WHEN** the server restarts and `init()` runs again with the same configuration
- **THEN** the factory SHALL update existing rows (matching on name) rather than creating duplicates
- **AND** the `updated_at` timestamp SHALL be refreshed

#### Scenario: Initialization runs only once per process
- **WHEN** multiple API requests hit the handler concurrently
- **THEN** the upsert SHALL execute at most once (guarded by a module-level initialized flag)

### Requirement: Drizzle adapter
The package SHALL export a `drizzleAdapter(db)` function from `khotan-data/factory` that accepts a Drizzle Postgres instance and returns an adapter object. The adapter SHALL provide methods for the factory to query and upsert plugs, flows, runs, resources, and mappings.

#### Scenario: Create adapter from Drizzle instance
- **WHEN** a user calls `drizzleAdapter(db)` with their Drizzle database instance
- **THEN** the function SHALL return an adapter object that the `khotan()` factory accepts

#### Scenario: Adapter uses khotan schema tables
- **WHEN** the adapter performs database operations
- **THEN** it SHALL operate on `khotan_plugs`, `khotan_flows`, `khotan_runs`, `khotan_resources`, and `khotan_mappings` tables as defined by the schema component

### Requirement: API handler
The factory's `handler` SHALL be a function that accepts a standard `Request` object and returns a `Response`. It SHALL route requests based on the URL path segments after the base path. It SHALL handle GET, POST, PUT, PATCH, and DELETE methods for resources, mappings, flow, variable, plug, wire, webhook-handler, and debug endpoints.

#### Scenario: List plugs
- **WHEN** the handler receives `GET .../plugs`
- **THEN** it SHALL return a JSON response with all plugs including their flow counts

#### Scenario: Get a single plug with flows
- **WHEN** the handler receives `GET .../plugs/:id`
- **THEN** it SHALL return a JSON response with the plug and its associated flows

#### Scenario: List flows
- **WHEN** the handler receives `GET .../flows`
- **THEN** it SHALL return a JSON response with all flows including their plug name

#### Scenario: List runs for a flow
- **WHEN** the handler receives `GET .../flows/:id/runs`
- **THEN** it SHALL return runs ordered by started_at descending

#### Scenario: Trigger a flow run
- **WHEN** the handler receives `POST .../flows/:id/runs`
- **THEN** it SHALL create a run row in `khotan_runs`
- **AND** if the registered flow has a `workflow` function, it SHALL start that Vercel Workflow and persist the returned Workflow run ID
- **AND** if the registered flow has an inline `run` function instead, it SHALL execute the function and update status, counters, metadata, and timing

#### Scenario: Persist sendUpdate history
- **WHEN** workflow code calls `sendUpdate(ctx, update)` with a Khotan workflow context
- **THEN** the runtime SHALL write the update to the Workflow stream
- **AND** it SHALL append the same update details to Khotan persistence for the run identified by `ctx.khotanRunId`

#### Scenario: Replay completed-run updates
- **WHEN** the handler receives `GET .../runs/:id/stream` for a completed run with persisted updates
- **THEN** it SHALL return the persisted updates as NDJSON
- **AND** it SHALL not require the Workflow live stream to still be available

### Requirement: Programmatic flow starter
The factory instance SHALL expose `flow(flowNameOrId, options?).start(startOptions?)` so application code can start a tracked flow run without calling Vercel Workflow APIs directly.

#### Scenario: Start a flow by registered name
- **WHEN** a user calls `khotanData.flow("products-inflow", { plugName: "shopify" }).start({ runType: "delta" })`
- **THEN** the factory SHALL resolve the registered flow, create a `khotan_runs` row, and start the registered flow execution path

#### Scenario: Ambiguous flow name
- **WHEN** multiple registered plugs have a flow with the same name
- **THEN** `flow(name).start()` SHALL throw and instruct the user to pass `{ plugName }`

#### Scenario: Toggle flow enabled
- **WHEN** the handler receives `PATCH .../flows/:id` with `{ enabled: boolean }`
- **THEN** it SHALL update the flow enabled state and return the updated payload

#### Scenario: Variable routes use variables naming
- **WHEN** the handler receives requests under `.../variables/:plugName`
- **THEN** it SHALL perform variable read/write/delete operations for that plug

#### Scenario: List resources
- **WHEN** the handler receives `GET .../resources`
- **THEN** it SHALL return a JSON response with all resources including flow and mapping counts

#### Scenario: Get a resource with flows
- **WHEN** the handler receives `GET .../resources/:id`
- **THEN** it SHALL return the resource with its associated flows
- **AND** if not found, return 404

#### Scenario: Get mappings for a resource
- **WHEN** the handler receives `GET .../resources/:id/mappings`
- **THEN** it SHALL return all mappings for that resource

#### Scenario: Create or upsert a mapping
- **WHEN** the handler receives `POST .../mappings` with a JSON body
- **THEN** it SHALL upsert the mapping and return the result

#### Scenario: Get a mapping
- **WHEN** the handler receives `GET .../mappings/:id`
- **THEN** it SHALL return the mapping or 404

#### Scenario: Update a mapping
- **WHEN** the handler receives `PUT .../mappings/:id` with a JSON body
- **THEN** it SHALL update the mapping and return the result

#### Scenario: Delete a mapping
- **WHEN** the handler receives `DELETE .../mappings/:id`
- **THEN** it SHALL delete the mapping and return 204

#### Scenario: Lookup mapping by plug and ref
- **WHEN** the handler receives `POST .../mappings/lookup` with body `{ resourceId, plugName, ref }`
- **THEN** it SHALL return the matching mapping or 404

#### Scenario: Unknown route
- **WHEN** the handler receives a request for an unknown path
- **THEN** the response status SHALL be 404 with a JSON error body

### Requirement: Next.js handler adapter
The package SHALL export a `toNextJsHandler(handler)` function from `khotan-data/factory` that converts the factory's handler into an object with `GET`, `POST`, `PUT`, `PATCH`, `DELETE` methods compatible with Next.js App Router route exports.

#### Scenario: Export as Next.js route
- **WHEN** a user writes `export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(khotanData.handler)`
- **THEN** each exported method SHALL accept a `NextRequest` and return a `Response`
- **AND** the handler SHALL strip the base path prefix (e.g., `/api/khotan`) and route based on remaining segments

### Requirement: Debug proxy route
The factory handler SHALL include a debug proxy route at `POST /api/khotan/debug/:plugName` that is only active when `KHOTAN_DEBUG` environment variable is truthy. The route proxies requests through the registered plug and returns structured response data including status, headers, body, and timing.

#### Scenario: Debug route registered when env var enabled
- **WHEN** `KHOTAN_DEBUG` is set and the factory handler receives `POST /api/khotan/debug/:plugName`
- **THEN** the handler routes to the debug proxy logic

#### Scenario: Debug route hidden when env var disabled
- **WHEN** `KHOTAN_DEBUG` is not set and the factory handler receives `POST /api/khotan/debug/:plugName`
- **THEN** the handler returns 404

### Requirement: Subpath export
The `khotan-data` package SHALL expose a `khotan-data/factory` subpath export that provides `khotan`, `drizzleAdapter`, and `toNextJsHandler`.

#### Scenario: Import from subpath
- **WHEN** a user writes `import { khotan, drizzleAdapter, toNextJsHandler } from "khotan-data/factory"`
- **THEN** all three functions SHALL be available and typed correctly

### Requirement: Factory validates resource mapping contracts
The khotan factory SHALL validate resource mapping declarations at configuration time before serving requests or initializing database state.

#### Scenario: Resource participant plug must be registered
- **WHEN** a resource declares a participating plug name that does not exist in the `plugs` registration array
- **THEN** the factory SHALL throw a configuration-time error

#### Scenario: Flow resource validation remains compatible
- **WHEN** a flow references a resource by name and that resource is registered with mapping-specific declarations
- **THEN** the factory SHALL still accept the flow-resource relationship
- **AND** the mapping-specific declarations SHALL NOT break normal flow registration

#### Scenario: Duplicate mapping participant definitions are rejected
- **WHEN** a resource config attempts to define the same participating plug more than once
- **THEN** the factory SHALL reject the configuration before initialization

### Requirement: Programmatic mapping accessors
The factory instance SHALL expose programmatic mapping helpers so application code can interact with mappings without issuing raw HTTP requests.

#### Scenario: Lookup mapping by connect value from application code
- **WHEN** application code requests a mapping using a resource identifier and canonical `connectValue`
- **THEN** the factory SHALL resolve and return the matching mapping row or null

#### Scenario: Lookup mapping by plug ref from application code
- **WHEN** application code requests a mapping using `{ resourceId, plugName, ref }`
- **THEN** the factory SHALL resolve and return the matching mapping row or null

#### Scenario: List mappings with pagination from application code
- **WHEN** application code requests mappings for a resource with pagination parameters
- **THEN** the factory SHALL return a paginated result rather than requiring callers to fetch the full mapping set

#### Scenario: Upsert mapping from application code
- **WHEN** application code submits `{ resourceId, connectValue, refs, metadata }`
- **THEN** the factory SHALL upsert the mapping through the adapter
- **AND** it SHALL return the created or updated identity result

#### Scenario: Delete mapping from application code
- **WHEN** application code requests deletion of a mapping by row ID
- **THEN** the factory SHALL delete that mapping through the adapter

### Requirement: Mapping list API supports operational browsing
The factory handler SHALL provide a mapping list surface suitable for browser UI and agent CLI use. The surface SHALL support pagination and search for a single resource.

#### Scenario: Paginated mapping list request
- **WHEN** the handler receives a request for mappings of one resource with `limit` and `offset`
- **THEN** it SHALL return only that slice of data
- **AND** it SHALL include pagination metadata sufficient for clients to continue browsing

#### Scenario: Mapping list search by connect value
- **WHEN** the handler receives a resource mappings request with a search term
- **THEN** it SHALL filter the result set according to the runtime search contract

#### Scenario: Mapping list remains resource-scoped
- **WHEN** the handler lists mappings for a resource
- **THEN** it SHALL scope the result set to that resource only
- **AND** it SHALL NOT mix mappings across resources

### Requirement: Mapping lookup API supports canonical connect value
The factory handler SHALL support direct mapping lookup by canonical `connectValue` in addition to lookup by plug ref.

#### Scenario: Lookup by connect value returns mapping
- **WHEN** the handler receives a mapping lookup request for an existing `{ resourceId, connectValue }`
- **THEN** it SHALL return the matching mapping row with a success status

#### Scenario: Lookup by connect value returns not found
- **WHEN** the handler receives a mapping lookup request for a missing `{ resourceId, connectValue }`
- **THEN** it SHALL return 404

#### Scenario: Lookup by connect value does not require row ID
- **WHEN** a caller knows the canonical shared identity but not the mapping row ID
- **THEN** the handler SHALL allow the caller to resolve the mapping without first listing all mappings

### Requirement: Mapping mutations enforce resource plug membership
When a resource declares participating plugs, the factory SHALL enforce that mapping mutations only write `refs` entries for those plugs.

#### Scenario: Upsert with allowed refs succeeds
- **WHEN** a mapping mutation includes only refs for plugs declared on the resource
- **THEN** the factory SHALL allow the mutation

#### Scenario: Upsert with undeclared ref plug fails
- **WHEN** a mapping mutation includes a ref key for a plug not declared on the resource
- **THEN** the factory SHALL reject the mutation with a client error

#### Scenario: Delete remains available for valid mapping row
- **WHEN** the caller deletes a mapping row by ID
- **THEN** plug membership validation SHALL NOT block the deletion

### Requirement: Factory validates cache registrations
The khotan factory SHALL validate registered cache definitions at configuration time before serving requests or initializing database state.

#### Scenario: Cache scope plug must exist
- **WHEN** a cache definition declares `scope.plug` and that plug name is not present in the registered `plugs` array
- **THEN** the factory SHALL reject the configuration before initialization

#### Scenario: Cache scope resource must exist
- **WHEN** a cache definition declares `scope.resource` and no resource with that name exists in the registered `resources` array
- **THEN** the factory SHALL reject the configuration before initialization

#### Scenario: Cache scope flow must exist
- **WHEN** a cache definition declares `scope.flow` and no registered flow with that name exists
- **THEN** the factory SHALL reject the configuration before initialization

#### Scenario: Cache names are unique
- **WHEN** two cache definitions are registered with the same `name`
- **THEN** the factory SHALL reject the configuration before initialization

### Requirement: Factory upserts registered cache definitions
When `init()` is called or the first handler request is received, the factory SHALL upsert registered cache definitions into the runtime's standard cache-definition table in addition to existing khotan resources, plugs, and flows.

#### Scenario: First initialization persists cache definitions
- **WHEN** the factory initializes with one or more registered cache definitions
- **THEN** it SHALL persist those definitions into the runtime data model

#### Scenario: Reinitialization updates cache definitions idempotently
- **WHEN** the process initializes again with the same cache definitions
- **THEN** the factory SHALL update existing definition rows rather than create duplicates

### Requirement: Programmatic cache accessors
The factory instance SHALL expose programmatic helpers for reading, writing, and deleting cache entries without requiring raw HTTP requests.

#### Scenario: Read cache entry from application code
- **WHEN** application code requests a cache entry by registered cache name and logical key
- **THEN** the factory SHALL return the cached value or null

#### Scenario: Write cache entry from application code
- **WHEN** application code writes a value to a registered cache name and logical key
- **THEN** the factory SHALL create or update that cache entry

#### Scenario: Delete cache entry from application code
- **WHEN** application code deletes a registered cache name and logical key
- **THEN** the factory SHALL remove that cache entry from normal reads

### Requirement: Workflow contexts expose cache helpers
Execution contexts used by flows, relays, catches, and passes SHALL provide workflow-safe cache helpers so durable workflows can use registered caches directly.

#### Scenario: Relay workflow reads cached snapshot
- **WHEN** a relay workflow needs a previously stored expensive fetch result
- **THEN** the workflow context SHALL allow the relay to read that cache entry without issuing a raw runtime HTTP request

#### Scenario: Pass workflow writes dedupe marker
- **WHEN** a pass workflow wants to mark an inbound event as already processed
- **THEN** the workflow context SHALL allow the pass to write a cache entry during execution

#### Scenario: Flow workflow busts stale cache key
- **WHEN** a flow workflow determines a cache entry must be refreshed
- **THEN** the workflow context SHALL allow the flow to delete that cache entry

### Requirement: Handler provides cache operations
The factory handler SHALL expose cache-entry operations through the standard khotan runtime route so future tooling can inspect and operate on registered caches.

#### Scenario: Lookup cache entry by cache and key
- **WHEN** the handler receives a request for a cache entry identified by a registered cache and logical key
- **THEN** it SHALL return the cached value or a not-found response

#### Scenario: Upsert cache entry through handler
- **WHEN** the handler receives a write request for a registered cache and logical key
- **THEN** it SHALL create or update the cache entry according to the cache contract

#### Scenario: Delete cache entry through handler
- **WHEN** the handler receives a delete request for a registered cache and logical key
- **THEN** it SHALL remove that cache entry from normal reads
