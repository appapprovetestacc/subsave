// Typed Drizzle helpers for the synced "orders" table. Generated
// by AppApprove (Phase 3.7 D). Edit freely — adding new helpers here is
// usually the right call before reaching for raw SQL.

import { and, asc, count, desc, eq, like, or } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb, schema } from "../../db/client.server";

export type OrdersRow = typeof schema.orders.$inferSelect;

export interface ListOrdersOpts {
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

export async function listOrders(
  d1: D1Database,
  opts: ListOrdersOpts,
): Promise<{ rows: OrdersRow[]; total: number }> {
  const db = getDb(d1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [eq(schema.orders.shop, opts.shop)];
  if (opts.search && opts.search.length > 0) {
    conditions.push(
      or(
      like(schema.orders.name, "%" + opts.search + "%"),
      like(schema.orders.email, "%" + opts.search + "%")
      )!,
    );
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const orderClause = opts.order === "oldest"
    ? asc(schema.orders.remoteUpdatedAt)
    : desc(schema.orders.remoteUpdatedAt);

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(schema.orders)
      .where(where)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(schema.orders).where(where),
  ]);

  return { rows: rows as OrdersRow[], total: totalRow[0]?.value ?? 0 };
}

export async function getOrders(
  d1: D1Database,
  shop: string,
  remoteId: string,
): Promise<OrdersRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.shop, shop), eq(schema.orders.remoteId, remoteId)))
    .limit(1);
  return (rows[0] ?? null) as OrdersRow | null;
}

export async function countOrders(d1: D1Database, shop: string): Promise<number> {
  const db = getDb(d1);
  const result = await db
    .select({ value: count() })
    .from(schema.orders)
    .where(eq(schema.orders.shop, shop));
  return result[0]?.value ?? 0;
}
