# Shared DB Packages

Use shared DB output when a monorepo owns Drizzle schema, config, and migrations
outside the Next.js app package.

```bash
npx khotan-data generate \
  --shared-db \
  --schema-output packages/databases/pipeline/src/khotan.ts \
  --schema-barrel packages/databases/pipeline/src/index.ts \
  --drizzle-config packages/databases/pipeline/drizzle.config.ts \
  --migrations-output packages/databases/pipeline/migrations \
  --db-package @acme/pipeline-db
```

This creates or updates:

```text
packages/databases/pipeline/src/khotan.ts
packages/databases/pipeline/src/index.ts
packages/databases/pipeline/drizzle.config.ts
packages/databases/pipeline/migrations/
```

The generated Drizzle config stores paths relative to the config file:

```typescript
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

In the app runtime, import the shared database instance from the workspace
package and keep the adapter import from `khotan-data/factory`:

```typescript
import { khotan, drizzleAdapter } from "khotan-data/factory";
import { db } from "@acme/pipeline-db";

const khotanData = khotan({
  adapter: drizzleAdapter(db),
  plugs: [],
});

export default khotanData;
```

`--shared-db` does not create an app-local `drizzle.config.ts`, install
`drizzle-kit`, or create local migrations. Run Drizzle Kit from the shared DB
package using the generated config.
