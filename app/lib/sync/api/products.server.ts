// Typed Drizzle helpers for the synced "products" table. Generated
// by AppApprove (Phase 3.7 D). Edit freely — adding new helpers here is
// usually the right call before reaching for raw SQL.

import { and, asc, count, desc, eq, like, or } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb, schema } from "../../db/client.server";

export type ProductsRow = typeof schema.products.$inferSelect;

export interface ListProductsOpts {
  shop: string;
  limit?: number;
  offset?: number;
  search?: string;
  // "newest" sorts by remoteUpdatedAt DESC (the common case); "oldest"
  // for backfill verification.
  order?: "newest" | "oldest";
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export async function listProducts(
  d1: D1Database,
  opts: ListProductsOpts,
): Promise<{ rows: ProductsRow[]; total: number }> {
  const db = getDb(d1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [eq(schema.products.shop, opts.shop)];
  if (opts.search && opts.search.length > 0) {
    conditions.push(
      or(
      like(schema.products.title, "%" + opts.search + "%"),
      like(schema.products.handle, "%" + opts.search + "%")
      )!,
    );
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const orderClause = opts.order === "oldest"
    ? asc(schema.products.remoteUpdatedAt)
    : desc(schema.products.remoteUpdatedAt);

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(schema.products)
      .where(where)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(schema.products).where(where),
  ]);

  return { rows: rows as ProductsRow[], total: totalRow[0]?.value ?? 0 };
}

export async function getProducts(
  d1: D1Database,
  shop: string,
  remoteId: string,
): Promise<ProductsRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.shop, shop), eq(schema.products.remoteId, remoteId)))
    .limit(1);
  return (rows[0] ?? null) as ProductsRow | null;
}

export async function countProducts(d1: D1Database, shop: string): Promise<number> {
  const db = getDb(d1);
  const result = await db
    .select({ value: count() })
    .from(schema.products)
    .where(eq(schema.products.shop, shop));
  return result[0]?.value ?? 0;
}
