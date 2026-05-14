// AppApprove sync schema (Phase 3.7 A). Drizzle table definitions for
// the Shopify resources you picked in the wizard, plus the cursor +
// dead-letter support tables shared across resources. Backed by
// Cloudflare D1 — keep types compatible with sqlite-core (text, integer,
// blob; no postgres-specific types).
//
// Edit freely: add columns, indexes, relations. After editing run
// `pnpm db:generate` to emit a new migration under migrations/, and
// `pnpm db:migrate` to apply it locally. The deploy workflow runs
// migrations against the production D1 database before the Worker boots.

import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const products = sqliteTable("products", {
  remoteId: text("remote_id").primaryKey(),
  shop: text("shop").notNull(),
  title: text("title").notNull(),
  handle: text("handle"),
  status: text("status"),
  payloadHash: text("payload_hash").notNull(),
  payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  remoteUpdatedAt: text("remote_updated_at").notNull(),
  syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopRemoteIdx: uniqueIndex("products_shop_remote_idx").on(table.shop, table.remoteId),
  shopUpdatedIdx: index("products_shop_updated_idx").on(table.shop, table.remoteUpdatedAt),
}));

export const productVariants = sqliteTable("product_variants", {
  remoteId: text("remote_id").primaryKey(),
  shop: text("shop").notNull(),
  productRemoteId: text("product_remote_id").notNull().references(() => products.remoteId, { onDelete: "cascade" }),
  sku: text("sku"),
  price: text("price"),
  inventoryQuantity: integer("inventory_quantity"),
  payloadHash: text("payload_hash").notNull(),
  payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  remoteUpdatedAt: text("remote_updated_at").notNull(),
  syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopRemoteIdx: uniqueIndex("variants_shop_remote_idx").on(table.shop, table.remoteId),
  productIdx: index("variants_product_idx").on(table.productRemoteId),
}));

export const orders = sqliteTable("orders", {
  remoteId: text("remote_id").primaryKey(),
  shop: text("shop").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  totalPrice: text("total_price"),
  currencyCode: text("currency_code"),
  financialStatus: text("financial_status"),
  fulfillmentStatus: text("fulfillment_status"),
  payloadHash: text("payload_hash").notNull(),
  payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  remoteUpdatedAt: text("remote_updated_at").notNull(),
  syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopRemoteIdx: uniqueIndex("orders_shop_remote_idx").on(table.shop, table.remoteId),
  shopUpdatedIdx: index("orders_shop_updated_idx").on(table.shop, table.remoteUpdatedAt),
}));

export const syncCursors = sqliteTable("sync_cursors", {
  shop: text("shop").notNull(),
  resource: text("resource").notNull(),
  cursor: text("cursor"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["idle", "running", "failed"] }).notNull().default("idle"),
  lastError: text("last_error"),
}, (table) => ({
  pk: primaryKey({ columns: [table.shop, table.resource] }),
}));

export const syncDeadLetter = sqliteTable("sync_dead_letter", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shop: text("shop").notNull(),
  resource: text("resource").notNull(),
  remoteId: text("remote_id"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  payloadHash: text("payload_hash"),
  error: text("error").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
}, (table) => ({
  shopResourceIdx: index("sync_dlq_shop_resource_idx").on(table.shop, table.resource),
  retryIdx: index("sync_dlq_retry_idx").on(table.nextRetryAt, table.resolvedAt),
}));
