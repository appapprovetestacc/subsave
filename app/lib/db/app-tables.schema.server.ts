// AppApprove app-owned tables (Phase 3.7 D). Independent of the
// Shopify-synced tables in schema.server.ts — these are records your app
// owns end-to-end (CRUD permitted, no Shopify round-trip needed).
//
// To add to the schema and migrate: append to schema.server.ts, then run
// `pnpm db:generate` to emit the next migration file under migrations/.

import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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

// ─── SubSave: recurring subscriptions ────────────────────────────────
//
// A subscription is a (shop, customer, product/variant) tuple with a
// cadence + lifecycle. Customers can pause, skip the next charge, or
// cancel. The renewals cron walks rows whose nextRenewalAt is due and
// charges the customer (Sprint 25 codegen wires the actual Billing/Draft
// Order API call); failures bump the dunning_attempts row and reschedule
// with exponential backoff.

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(), // e.g. "sub_<uuid>" — app-generated
  shop: text("shop").notNull(),
  customerRemoteId: text("customer_remote_id").notNull(), // gid://shopify/Customer/...
  customerEmail: text("customer_email"),
  productRemoteId: text("product_remote_id").notNull(),
  variantRemoteId: text("variant_remote_id"),
  quantity: integer("quantity").notNull().default(1),
  // cadence is days-between-charges. 30 = monthly. Edit via admin UI.
  cadenceDays: integer("cadence_days").notNull().default(30),
  // priceCents stored as integer to avoid float drift. Currency mirrors
  // the shop's currencyCode at subscribe time.
  priceCents: integer("price_cents").notNull(),
  currencyCode: text("currency_code").notNull().default("USD"),
  status: text("status", {
    enum: ["active", "paused", "cancelled"],
  }).notNull().default("active"),
  nextRenewalAt: integer("next_renewal_at", { mode: "timestamp_ms" }).notNull(),
  lastChargeAt: integer("last_charge_at", { mode: "timestamp_ms" }),
  // skipNextRenewal: when true, the next renewal tick advances
  // nextRenewalAt by cadenceDays without charging, then clears the flag.
  skipNextRenewal: integer("skip_next_renewal", { mode: "boolean" }).notNull().default(false),
  // preRenewalEmailSentAt: set when the 3-days-out reminder went out for
  // the upcoming nextRenewalAt — cleared on each successful renewal so
  // the next cycle re-arms the reminder.
  preRenewalEmailSentAt: integer("pre_renewal_email_sent_at", { mode: "timestamp_ms" }),
  cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
  cancelReason: text("cancel_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopIdx: index("subscriptions_shop_idx").on(table.shop),
  shopStatusIdx: index("subscriptions_shop_status_idx").on(table.shop, table.status),
  renewalIdx: index("subscriptions_renewal_idx").on(table.status, table.nextRenewalAt),
  customerIdx: index("subscriptions_customer_idx").on(table.shop, table.customerRemoteId),
}));

// One charge attempt per renewal tick. status = "succeeded" closes the
// cycle and advances nextRenewalAt on the parent subscription. status =
// "failed" creates a dunning_attempts row keyed by chargeId.
export const subscriptionCharges = sqliteTable("subscription_charges", {
  id: text("id").primaryKey(), // "chg_<uuid>"
  shop: text("shop").notNull(),
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  currencyCode: text("currency_code").notNull(),
  status: text("status", {
    enum: ["pending", "succeeded", "failed"],
  }).notNull().default("pending"),
  // shopifyDraftOrderId / shopifyOrderId — populated by Sprint 25
  // codegen when the Billing/Draft-Order call returns. Stored here so
  // the renewals cron can correlate webhook updates back to the charge.
  shopifyDraftOrderId: text("shopify_draft_order_id"),
  shopifyOrderId: text("shopify_order_id"),
  failureCode: text("failure_code"),
  failureMessage: text("failure_message"),
  attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  succeededAt: integer("succeeded_at", { mode: "timestamp_ms" }),
}, (table) => ({
  subIdx: index("charges_subscription_idx").on(table.subscriptionId, table.attemptedAt),
  shopStatusIdx: index("charges_shop_status_idx").on(table.shop, table.status),
}));

// Dunning queue. One row per failed charge that is still being retried.
// resolvedAt set to NOT NULL when the retries succeed OR the subscription
// is auto-cancelled after max attempts.
export const dunningAttempts = sqliteTable("dunning_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shop: text("shop").notNull(),
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  chargeId: text("charge_id").notNull().references(() => subscriptionCharges.id, { onDelete: "cascade" }),
  retryCount: integer("retry_count").notNull().default(0),
  // exponential backoff: nextRetryAt = now + 2^retryCount * baseHours
  // (capped at MAX_DUNNING_RETRIES — see app/lib/subscriptions.server.ts).
  nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }).notNull(),
  lastError: text("last_error"),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  resolution: text("resolution", { enum: ["charge_succeeded", "auto_cancelled", "manual"] }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  retryIdx: index("dunning_retry_idx").on(table.nextRetryAt, table.resolvedAt),
  subIdx: index("dunning_subscription_idx").on(table.subscriptionId),
  chargeUniqueIdx: uniqueIndex("dunning_charge_unique_idx").on(table.chargeId),
}));
