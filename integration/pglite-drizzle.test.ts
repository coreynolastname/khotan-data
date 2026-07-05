import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { fromQueryPaginated, khotanUpsert, toDrizzle } from "../src/drizzle.js";
import { drizzleAdapter, khotan } from "../src/factory.js";

const products = pgTable("products", {
  id: text("id").primaryKey(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  emailDomain: text("email_domain"),
  quantity: integer("quantity").notNull().default(0),
});

async function createDb() {
  const client = new PGlite();
  const db = drizzle(client);

  await db.execute(sql`
    create table products (
      id text primary key,
      sku text not null unique,
      name text not null,
      status text not null,
      email_domain text,
      quantity integer not null default 0
    )
  `);

  return { client, db };
}

async function createKhotanDb() {
  const client = new PGlite();
  const db = drizzle(client);

  await db.execute(sql`
    create table khotan_caches (
      id text primary key,
      name text not null unique,
      scope jsonb,
      ttl_seconds integer,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null
    )
  `);
  await db.execute(sql`
    create table khotan_cache_entries (
      id text primary key,
      cache_id text not null,
      key text not null,
      value jsonb not null,
      expires_at timestamp with time zone,
      created_at timestamp with time zone default now() not null,
      updated_at timestamp with time zone default now() not null,
      constraint khotan_cache_entries_cache_id_key_unique unique (cache_id, key)
    )
  `);

  return { client, db };
}

describe("PGlite Drizzle integration", () => {
  it("loads, dedupes, coerces, and preserves excluded fields with a real database", async () => {
    const { client, db } = await createDb();

    try {
      const loader = toDrizzle(
        "seed-products",
        (rows: Array<typeof products.$inferInsert>) =>
          db.insert(products).values(rows),
      );
      const seed = await loader.load([
        {
          id: "product-1",
          sku: "SKU-1",
          name: "Original",
          status: "active",
          emailDomain: "learned.example",
          quantity: 1,
        },
      ]);

      expect(seed.recordsLoaded).toBe(1);
      expect(seed.errors).toEqual([]);

      const upsert = await khotanUpsert(db, {
        table: products,
        records: [
          {
            id: "ignored-id",
            sku: "SKU-1",
            name: "Updated",
            status: "inactive",
            emailDomain: "should-not-overwrite.example",
            quantity: 3,
          },
          {
            id: "product-2",
            sku: "SKU-2",
            name: "Second",
            status: "active",
            emailDomain: "second.example",
            quantity: 4,
          },
          {
            id: "duplicate-product-2",
            sku: "SKU-2",
            name: "Duplicate skipped",
            status: "active",
            emailDomain: "duplicate.example",
            quantity: 99,
          },
        ],
        conflictKey: "sku",
        excludeOnUpdate: ["id", "emailDomain"],
        dedupe: "first-wins",
        coerceEnum: {
          status: {
            inactive: "archived",
          },
        },
      });

      expect(upsert).toEqual({
        recordsReceived: 3,
        recordsUpserted: 2,
        recordsSkipped: 1,
      });

      const rows = await db
        .select()
        .from(products)
        .where(eq(products.sku, "SKU-1"));

      expect(rows[0]).toMatchObject({
        id: "product-1",
        sku: "SKU-1",
        name: "Updated",
        status: "archived",
        emailDomain: "learned.example",
        quantity: 3,
      });
    } finally {
      await client.close();
    }
  });

  it("extracts paginated Drizzle rows from PGlite", async () => {
    const { client, db } = await createDb();

    try {
      await db.insert(products).values([
        { id: "product-1", sku: "SKU-1", name: "One", status: "active" },
        { id: "product-2", sku: "SKU-2", name: "Two", status: "active" },
        { id: "product-3", sku: "SKU-3", name: "Three", status: "active" },
      ]);

      const extractor = fromQueryPaginated("products", {
        pageSize: 2,
        query: (limit, offset) =>
          db
            .select({
              sku: products.sku,
              name: products.name,
            })
            .from(products)
            .orderBy(products.sku)
            .limit(limit)
            .offset(offset),
      });

      const extracted: Array<{ sku: string; name: string }> = [];
      for await (const row of extractor.extract()) {
        extracted.push(row);
      }

      expect(extracted).toEqual([
        { sku: "SKU-1", name: "One" },
        { sku: "SKU-2", name: "Two" },
        { sku: "SKU-3", name: "Three" },
      ]);
    } finally {
      await client.close();
    }
  });

  it("runs atomic cache helpers through the Drizzle adapter", async () => {
    const { client, db } = await createKhotanDb();

    try {
      const instance = khotan({
        adapter: drizzleAdapter(db),
        authorize: false,
        plugs: [],
        caches: [{ name: "atomic-cache" }],
      });
      const cache = instance.cache("atomic-cache");

      await cache.set("cursor", { page: 1 });
      const before = await cache.getWithMetadata<{ page: number }>("cursor");
      expect(before?.version).toBeTruthy();

      const updated = await cache.compareAndSet(
        "cursor",
        { page: 2 },
        { ifVersion: before!.version },
      );
      expect(updated.ok).toBe(true);
      expect(updated.entry?.value).toEqual({ page: 2 });

      const stale = await cache.compareAndSet(
        "cursor",
        { page: 3 },
        { ifVersion: before!.version },
      );
      expect(stale.ok).toBe(false);
      await expect(cache.get("cursor")).resolves.toEqual({ page: 2 });

      const claimed = await cache.claim(
        "lease",
        { runId: "run-1" },
        { owner: "run-1", ttl: "30s" },
      );
      expect(claimed.claimed).toBe(true);

      const blocked = await cache.claim(
        "lease",
        { runId: "run-2" },
        { owner: "run-2", ttl: "30s" },
      );
      expect(blocked.claimed).toBe(false);

      const released = await cache.release("lease", {
        owner: "run-1",
        nextValue: { done: true },
        cooldownUntil: new Date(Date.now() - 1_000),
      });
      expect(released.released).toBe(true);

      const reclaimedAfterCooldown = await cache.claim(
        "lease",
        { runId: "run-2" },
        { owner: "run-2", ttl: "30s" },
      );
      expect(reclaimedAfterCooldown.claimed).toBe(true);

      const firstDedupe = await cache.markDedupe(
        "event:evt-1",
        { eventId: "evt-1" },
        { ttl: "30s" },
      );
      expect(firstDedupe.marked).toBe(true);

      const duplicate = await cache.markDedupe(
        "event:evt-1",
        { eventId: "evt-1-again" },
        { ttl: "30s" },
      );
      expect(duplicate.marked).toBe(false);
      expect(duplicate.duplicate).toBe(true);
    } finally {
      await client.close();
    }
  });
});
