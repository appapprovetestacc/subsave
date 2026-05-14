// AppApprove app-owned tables (Phase 3.7 D). Independent of the
// Shopify-synced tables in schema.server.ts — these are records your app
// owns end-to-end (CRUD permitted, no Shopify round-trip needed).
//
// To add to the schema and migrate: append to schema.server.ts, then run
// `pnpm db:generate` to emit the next migration file under migrations/.

import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

// Per-shop app settings — config the merchant edits in your admin UI.
// Single row per shop; the JSON `value` column is the catch-all for
// schemaless config so you don't have to migrate when adding a new field.
export const appSettings = sqliteTable("app_settings", {
  shop: text("shop").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<Record<string, unknown>>().$defaultFn(() => ({})),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Custom records — a generic key/value table per (shop, namespace, key).
// Useful as a starter for app-specific data without designing a new
// schema upfront. Replace with a typed table once your data shape
// stabilises.
export const customRecords = sqliteTable("custom_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shop: text("shop").notNull(),
  namespace: text("namespace").notNull(),
  key: text("key").notNull(),
  value: text("value", { mode: "json" }).notNull().$type<unknown>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  pk: index("custom_records_lookup_idx").on(table.shop, table.namespace, table.key),
}));
