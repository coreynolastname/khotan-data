import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { fromQueryPaginated, khotanUpsert, toDrizzle } from "../src/drizzle.js";

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
});
