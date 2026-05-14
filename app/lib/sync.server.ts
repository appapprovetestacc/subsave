// Sync runtime — payload-hash dedupe, idempotent upserts, cursor
// management, dead-letter scheduling. Generated apps call these from
// webhook handlers (`upsertResource`) and from background backfill
// jobs (`fetchCursor` / `saveCursor`). The actual D1 queries live in
// app/lib/db/schema.server.ts via Drizzle.

import { eq, and } from "drizzle-orm";
import { getDb, schema } from "./db/client.server";
import type { D1Database } from "@cloudflare/workers-types";

export type SyncResource = "products" | "variants" | "orders";

export interface SyncCursorRow {
  shop: string;
  resource: SyncResource;
  cursor: string | null;
  lastSyncedAt: Date | null;
  status: "idle" | "running" | "failed";
  lastError: string | null;
}

export interface UpsertResult {
  resource: SyncResource;
  remoteId: string;
  changed: boolean;
}

// Stable JSON hash — sort keys before stringifying so two payloads with
// equivalent contents but different key order produce the same hash.
// Uses Web Crypto SHA-256 (available in CF Workers runtime).
export async function payloadHash(payload: Record<string, unknown>): Promise<string> {
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  const buf = new TextEncoder().encode(stable);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function fetchCursor(
  d1: D1Database,
  shop: string,
  resource: SyncResource,
): Promise<SyncCursorRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(schema.syncCursors)
    .where(and(eq(schema.syncCursors.shop, shop), eq(schema.syncCursors.resource, resource)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    shop: row.shop,
    resource: row.resource as SyncResource,
    cursor: row.cursor,
    lastSyncedAt: row.lastSyncedAt,
    status: row.status,
    lastError: row.lastError,
  };
}

export async function saveCursor(
  d1: D1Database,
  shop: string,
  resource: SyncResource,
  cursor: string | null,
  status: SyncCursorRow["status"] = "idle",
  lastError: string | null = null,
): Promise<void> {
  const db = getDb(d1);
  // D1/SQLite supports ON CONFLICT (shop, resource) DO UPDATE — drizzle
  // exposes this via .onConflictDoUpdate({ target, set }).
  await db
    .insert(schema.syncCursors)
    .values({
      shop,
      resource,
      cursor,
      lastSyncedAt: new Date(),
      status,
      lastError,
    })
    .onConflictDoUpdate({
      target: [schema.syncCursors.shop, schema.syncCursors.resource],
      set: { cursor, lastSyncedAt: new Date(), status, lastError },
    });
}

// Recordable as JSON-serialisable; `payload` must already match the
// table's row shape (use the per-resource mapper from
// app/lib/sync/backfill-queries.ts to convert a Shopify node).
export interface UpsertInput {
  shop: string;
  resource: SyncResource;
  remoteId: string;
  remoteUpdatedAt: string;
  row: Record<string, unknown>;
}

export async function upsertResource(d1: D1Database, input: UpsertInput): Promise<UpsertResult> {
  const db = getDb(d1);
  const hash = await payloadHash(input.row);
  // Cheap dedupe — compare against the existing payload_hash before
  // writing. Saves a write when Shopify replays the same webhook.
  // resourceTable() returns `any` (each resource has a distinct table
  // shape; the union doesn't share columns) so TS can't typecheck the
  // column access — runtime is correct via the switch in resourceTable.
  const table = resourceTable(input.resource);
  const existing = await db
    .select({ payloadHash: table.payloadHash })
    .from(table)
    .where(and(eq(table.shop, input.shop), eq(table.remoteId, input.remoteId)))
    .limit(1);
  if (existing[0] && existing[0].payloadHash === hash) {
    return { resource: input.resource, remoteId: input.remoteId, changed: false };
  }
  await db
    .insert(table)
    .values({ ...input.row, payloadHash: hash, syncedAt: new Date() })
    .onConflictDoUpdate({
      target: table.remoteId,
      set: { ...input.row, payloadHash: hash, syncedAt: new Date() },
    });
  return { resource: input.resource, remoteId: input.remoteId, changed: true };
}

// Map resource → drizzle table object. Returns `any` because each
// resource has a distinct table shape; the union of all tables collapses
// to `never` when accessing shared-by-name-only columns. Runtime is
// correct via the switch below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resourceTable(resource: SyncResource): any {
  switch (resource) {
    case "products": return schema.products;
    case "variants": return schema.productVariants;
    case "orders": return schema.orders;
    default: throw new Error("Unknown sync resource: " + (resource as string));
  }
}

// Dead-letter helpers — surface failures to the AppApprove dashboard
// (Sprint 3.7 C UI consumes these rows) and schedule the retry. Backoff:
// 1m, 2m, 4m, … capped at 60m. Failed events older than 7 days should be
// archived by a cron — provided as a starter helper but you wire the
// schedule in wrangler.toml.

export interface DeadLetterInput {
  shop: string;
  resource: SyncResource;
  remoteId?: string;
  payload?: Record<string, unknown>;
  error: string;
}

export async function recordDeadLetter(
  d1: D1Database,
  input: DeadLetterInput,
  retryCount: number = 0,
): Promise<void> {
  const db = getDb(d1);
  const minutes = Math.min(60, Math.pow(2, retryCount));
  const hash = input.payload ? await payloadHash(input.payload) : null;
  await db.insert(schema.syncDeadLetter).values({
    shop: input.shop,
    resource: input.resource,
    remoteId: input.remoteId ?? null,
    payload: input.payload ?? null,
    payloadHash: hash,
    error: input.error,
    retryCount,
    nextRetryAt: new Date(Date.now() + minutes * 60_000),
  });
}

// PII redactor — used by the GDPR customers/redact webhook handler to
// erase the payload column before tombstoning a customer row. Returns a
// shallow copy with personal-data keys replaced by "[redacted]".
export function redactSyncPayload<T extends Record<string, unknown>>(payload: T): T {
  const copy = { ...payload };
  for (const key of Object.keys(copy)) {
    if (/email|phone|address|name|firstName|lastName/i.test(key)) {
      copy[key as keyof T] = "[redacted]" as T[keyof T];
    }
  }
  return copy;
}
