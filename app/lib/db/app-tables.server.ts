// CRUD helpers for the app-owned tables in app-tables.schema.server.ts.
// Use these as the canonical pattern when building features that read or
// write app-owned data. The Shopify-synced tables (products, orders,
// customers, collections, inventory_items) are READ-ONLY from your app's
// perspective — Shopify is the source of truth, mutate via the Admin API.

import { and, desc, eq } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb } from "../db/client.server";
import { appSettings, customRecords } from "../db/app-tables.schema.server";

// ─── App settings ─────────────────────────────────────────────────────

export async function getAppSettings<T extends Record<string, unknown>>(
  d1: D1Database,
  shop: string,
): Promise<T> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.shop, shop))
    .limit(1);
  return ((rows[0]?.value ?? {}) as T);
}

export async function putAppSettings<T extends Record<string, unknown>>(
  d1: D1Database,
  shop: string,
  value: T,
): Promise<void> {
  const db = getDb(d1);
  await db
    .insert(appSettings)
    .values({ shop, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.shop,
      set: { value, updatedAt: new Date() },
    });
}

// ─── Custom records ───────────────────────────────────────────────────

export interface CustomRecordKey {
  shop: string;
  namespace: string;
  key: string;
}

export async function getCustomRecord<T = unknown>(
  d1: D1Database,
  k: CustomRecordKey,
): Promise<T | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(customRecords)
    .where(
      and(
        eq(customRecords.shop, k.shop),
        eq(customRecords.namespace, k.namespace),
        eq(customRecords.key, k.key),
      ),
    )
    .limit(1);
  return ((rows[0]?.value ?? null) as T | null);
}

export async function putCustomRecord<T>(
  d1: D1Database,
  k: CustomRecordKey,
  value: T,
): Promise<void> {
  const db = getDb(d1);
  // SQLite's ON CONFLICT requires a unique index on the conflict columns;
  // the lookup index is non-unique by design (multiple values per (shop,
  // ns, key) are nonsense but allowed). So instead: explicit existence
  // check + update-or-insert.
  const existing = await db
    .select({ id: customRecords.id })
    .from(customRecords)
    .where(
      and(
        eq(customRecords.shop, k.shop),
        eq(customRecords.namespace, k.namespace),
        eq(customRecords.key, k.key),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(customRecords)
      .set({ value, updatedAt: new Date() })
      .where(eq(customRecords.id, existing[0].id));
  } else {
    await db.insert(customRecords).values({
      shop: k.shop,
      namespace: k.namespace,
      key: k.key,
      value,
    });
  }
}

export async function deleteCustomRecord(
  d1: D1Database,
  k: CustomRecordKey,
): Promise<void> {
  const db = getDb(d1);
  await db
    .delete(customRecords)
    .where(
      and(
        eq(customRecords.shop, k.shop),
        eq(customRecords.namespace, k.namespace),
        eq(customRecords.key, k.key),
      ),
    );
}

export async function listCustomRecords(
  d1: D1Database,
  shop: string,
  namespace: string,
  limit: number = 100,
): Promise<Array<{ key: string; value: unknown; updatedAt: Date }>> {
  const db = getDb(d1);
  const rows = await db
    .select({
      key: customRecords.key,
      value: customRecords.value,
      updatedAt: customRecords.updatedAt,
    })
    .from(customRecords)
    .where(and(eq(customRecords.shop, shop), eq(customRecords.namespace, namespace)))
    .orderBy(desc(customRecords.updatedAt))
    .limit(limit);
  return rows;
}
