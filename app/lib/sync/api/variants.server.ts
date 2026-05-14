// Typed Drizzle helpers for the synced "variants" table. Generated
// by AppApprove (Phase 3.7 D). Edit freely — adding new helpers here is
// usually the right call before reaching for raw SQL.

import { and, asc, count, desc, eq, like, or } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb, schema } from "../../db/client.server";

export type ProductVariantsRow = typeof schema.productVariants.$inferSelect;

export interface ListProductVariantsOpts {
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

export async function listProductVariants(
  d1: D1Database,
  opts: ListProductVariantsOpts,
): Promise<{ rows: ProductVariantsRow[]; total: number }> {
  const db = getDb(d1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [eq(schema.productVariants.shop, opts.shop)];
  if (opts.search && opts.search.length > 0) {
    conditions.push(
      or(
      like(schema.productVariants.sku, "%" + opts.search + "%")
      )!,
    );
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const orderClause = opts.order === "oldest"
    ? asc(schema.productVariants.remoteUpdatedAt)
    : desc(schema.productVariants.remoteUpdatedAt);

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(schema.productVariants)
      .where(where)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(schema.productVariants).where(where),
  ]);

  return { rows: rows as ProductVariantsRow[], total: totalRow[0]?.value ?? 0 };
}

export async function getProductVariants(
  d1: D1Database,
  shop: string,
  remoteId: string,
): Promise<ProductVariantsRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(schema.productVariants)
    .where(and(eq(schema.productVariants.shop, shop), eq(schema.productVariants.remoteId, remoteId)))
    .limit(1);
  return (rows[0] ?? null) as ProductVariantsRow | null;
}

export async function countProductVariants(d1: D1Database, shop: string): Promise<number> {
  const db = getDb(d1);
  const result = await db
    .select({ value: count() })
    .from(schema.productVariants)
    .where(eq(schema.productVariants.shop, shop));
  return result[0]?.value ?? 0;
}
