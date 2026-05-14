// SubSave — subscription state machine + dunning helpers. Pure D1
// helpers; no Shopify Admin API calls live here. The Billing/Draft-Order
// integration is wired in by Sprint 25 codegen from pricing.yaml — until
// then, chargeSubscription() simulates a charge attempt and returns a
// pluggable result so the cron + admin flows are exercisable end-to-end.

import { and, asc, desc, eq, lte, isNull, ne } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb } from "./db/client.server";
import {
  subscriptions,
  subscriptionCharges,
  dunningAttempts,
} from "./db/app-tables.schema.server";

export type SubscriptionStatus = "active" | "paused" | "cancelled";
export type ChargeStatus = "pending" | "succeeded" | "failed";

export interface SubscriptionRow {
  id: string;
  shop: string;
  customerRemoteId: string;
  customerEmail: string | null;
  productRemoteId: string;
  variantRemoteId: string | null;
  quantity: number;
  cadenceDays: number;
  priceCents: number;
  currencyCode: string;
  status: SubscriptionStatus;
  nextRenewalAt: Date;
  lastChargeAt: Date | null;
  skipNextRenewal: boolean;
  preRenewalEmailSentAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubscriptionInput {
  shop: string;
  customerRemoteId: string;
  customerEmail?: string | null;
  productRemoteId: string;
  variantRemoteId?: string | null;
  quantity?: number;
  cadenceDays?: number;
  priceCents: number;
  currencyCode?: string;
  /** First charge date. Defaults to `cadenceDays` from now. */
  firstRenewalAt?: Date;
}

// Dunning policy — exponential backoff in hours. Caller bumps retryCount
// after each failure; we stop retrying past MAX_DUNNING_RETRIES and
// auto-cancel the subscription.
export const MAX_DUNNING_RETRIES = 4;
const DUNNING_BACKOFF_HOURS = [24, 48, 96, 168]; // 1d, 2d, 4d, 7d
export const PRE_RENEWAL_REMINDER_DAYS = 3;

function nextRetryAt(retryCount: number, now: Date = new Date()): Date {
  const idx = Math.min(retryCount, DUNNING_BACKOFF_HOURS.length - 1);
  const hours = DUNNING_BACKOFF_HOURS[idx] ?? 168;
  return new Date(now.getTime() + hours * 3600_000);
}

function uid(prefix: string): string {
  // 16 random bytes → 32 hex chars. Workers exposes globalThis.crypto.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + "_" + hex;
}

export async function createSubscription(
  d1: D1Database,
  input: CreateSubscriptionInput,
): Promise<SubscriptionRow> {
  const db = getDb(d1);
  const cadenceDays = input.cadenceDays ?? 30;
  const firstRenewalAt =
    input.firstRenewalAt ?? new Date(Date.now() + cadenceDays * 86_400_000);
  const id = uid("sub");
  const now = new Date();
  await db.insert(subscriptions).values({
    id,
    shop: input.shop,
    customerRemoteId: input.customerRemoteId,
    customerEmail: input.customerEmail ?? null,
    productRemoteId: input.productRemoteId,
    variantRemoteId: input.variantRemoteId ?? null,
    quantity: input.quantity ?? 1,
    cadenceDays,
    priceCents: input.priceCents,
    currencyCode: input.currencyCode ?? "USD",
    status: "active",
    nextRenewalAt: firstRenewalAt,
    skipNextRenewal: false,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getSubscription(d1, id);
  if (!row) throw new Error("Failed to load subscription " + id + " after insert");
  return row;
}

export async function getSubscription(
  d1: D1Database,
  id: string,
): Promise<SubscriptionRow | null> {
  const db = getDb(d1);
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  return (rows[0] as SubscriptionRow | undefined) ?? null;
}

export async function listSubscriptions(
  d1: D1Database,
  shop: string,
  opts: { status?: SubscriptionStatus; limit?: number } = {},
): Promise<SubscriptionRow[]> {
  const db = getDb(d1);
  const whereClause = opts.status
    ? and(eq(subscriptions.shop, shop), eq(subscriptions.status, opts.status))
    : eq(subscriptions.shop, shop);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(whereClause)
    .orderBy(desc(subscriptions.createdAt))
    .limit(opts.limit ?? 100);
  return rows as SubscriptionRow[];
}

export async function pauseSubscription(d1: D1Database, id: string): Promise<void> {
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({ status: "paused", updatedAt: new Date() })
    .where(and(eq(subscriptions.id, id), ne(subscriptions.status, "cancelled")));
}

export async function resumeSubscription(d1: D1Database, id: string): Promise<void> {
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.status, "paused")));
}

export async function skipNextRenewal(d1: D1Database, id: string): Promise<void> {
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({ skipNextRenewal: true, updatedAt: new Date() })
    .where(and(eq(subscriptions.id, id), eq(subscriptions.status, "active")));
}

export async function cancelSubscription(
  d1: D1Database,
  id: string,
  reason?: string,
): Promise<void> {
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, id));
}

export async function updateCadence(
  d1: D1Database,
  id: string,
  cadenceDays: number,
): Promise<void> {
  if (cadenceDays < 1 || cadenceDays > 365) {
    throw new Error("cadenceDays must be 1..365 (got " + cadenceDays + ")");
  }
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({ cadenceDays, updatedAt: new Date() })
    .where(eq(subscriptions.id, id));
}

// ─── Charge + dunning ─────────────────────────────────────────────────

export interface ChargeResult {
  ok: boolean;
  chargeId: string;
  failureCode?: string;
  failureMessage?: string;
  shopifyDraftOrderId?: string;
  shopifyOrderId?: string;
}

// Stub charger. Sprint 25 wires the actual Billing/Draft-Order GraphQL
// mutation here. For now, the simulated charge always succeeds — the
// cron tick uses this for the happy path, and tests can override the
// charger to exercise the dunning branch.
export type ChargeFn = (sub: SubscriptionRow) => Promise<ChargeResult>;

const defaultCharger: ChargeFn = async (sub) => ({
  ok: true,
  chargeId: uid("chg"),
  shopifyDraftOrderId: "draft_pending_codegen_" + sub.id,
});

export async function attemptCharge(
  d1: D1Database,
  sub: SubscriptionRow,
  charger: ChargeFn = defaultCharger,
): Promise<{ charge: ChargeResult; chargeRowId: string }> {
  const db = getDb(d1);
  const chargeRowId = uid("chg");
  await db.insert(subscriptionCharges).values({
    id: chargeRowId,
    shop: sub.shop,
    subscriptionId: sub.id,
    amountCents: sub.priceCents,
    currencyCode: sub.currencyCode,
    status: "pending",
    attemptedAt: new Date(),
  });
  const result = await charger(sub);
  await db
    .update(subscriptionCharges)
    .set({
      status: result.ok ? "succeeded" : "failed",
      shopifyDraftOrderId: result.shopifyDraftOrderId ?? null,
      shopifyOrderId: result.shopifyOrderId ?? null,
      failureCode: result.failureCode ?? null,
      failureMessage: result.failureMessage ?? null,
      succeededAt: result.ok ? new Date() : null,
    })
    .where(eq(subscriptionCharges.id, chargeRowId));
  return { charge: { ...result, chargeId: chargeRowId }, chargeRowId };
}

export async function advanceAfterSuccess(d1: D1Database, sub: SubscriptionRow): Promise<void> {
  const db = getDb(d1);
  const next = new Date(sub.nextRenewalAt.getTime() + sub.cadenceDays * 86_400_000);
  await db
    .update(subscriptions)
    .set({
      lastChargeAt: new Date(),
      nextRenewalAt: next,
      // Clear the reminder flag so the next cycle re-arms it.
      preRenewalEmailSentAt: null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, sub.id));
}

export async function advanceForSkip(d1: D1Database, sub: SubscriptionRow): Promise<void> {
  const db = getDb(d1);
  const next = new Date(sub.nextRenewalAt.getTime() + sub.cadenceDays * 86_400_000);
  await db
    .update(subscriptions)
    .set({
      nextRenewalAt: next,
      skipNextRenewal: false,
      preRenewalEmailSentAt: null,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, sub.id));
}

export async function openDunning(
  d1: D1Database,
  sub: SubscriptionRow,
  chargeRowId: string,
  failureMessage: string,
): Promise<void> {
  const db = getDb(d1);
  await db.insert(dunningAttempts).values({
    shop: sub.shop,
    subscriptionId: sub.id,
    chargeId: chargeRowId,
    retryCount: 0,
    nextRetryAt: nextRetryAt(0),
    lastError: failureMessage.slice(0, 500),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function bumpDunning(
  d1: D1Database,
  attemptId: number,
  retryCount: number,
  failureMessage: string,
): Promise<void> {
  const db = getDb(d1);
  await db
    .update(dunningAttempts)
    .set({
      retryCount: retryCount + 1,
      nextRetryAt: nextRetryAt(retryCount + 1),
      lastError: failureMessage.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(dunningAttempts.id, attemptId));
}

export async function resolveDunning(
  d1: D1Database,
  attemptId: number,
  resolution: "charge_succeeded" | "auto_cancelled" | "manual",
): Promise<void> {
  const db = getDb(d1);
  await db
    .update(dunningAttempts)
    .set({
      resolvedAt: new Date(),
      resolution,
      updatedAt: new Date(),
    })
    .where(eq(dunningAttempts.id, attemptId));
}

// Pulls overdue active subscriptions whose nextRenewalAt is <= now. Cap
// per-tick to avoid blowing the cron 30s budget.
export const RENEWAL_TICK_BATCH_SIZE = 50;

export async function listDueRenewals(
  d1: D1Database,
  now: Date = new Date(),
  limit: number = RENEWAL_TICK_BATCH_SIZE,
): Promise<SubscriptionRow[]> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"),
        lte(subscriptions.nextRenewalAt, now),
      ),
    )
    .orderBy(asc(subscriptions.nextRenewalAt))
    .limit(limit);
  return rows as SubscriptionRow[];
}

// Subscriptions whose next renewal is within `windowDays` and whose
// pre-renewal reminder hasn't been sent yet for this cycle.
export async function listSubscriptionsNeedingReminder(
  d1: D1Database,
  windowDays: number = PRE_RENEWAL_REMINDER_DAYS,
  now: Date = new Date(),
  limit: number = RENEWAL_TICK_BATCH_SIZE,
): Promise<SubscriptionRow[]> {
  const db = getDb(d1);
  const windowEnd = new Date(now.getTime() + windowDays * 86_400_000);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"),
        lte(subscriptions.nextRenewalAt, windowEnd),
        isNull(subscriptions.preRenewalEmailSentAt),
      ),
    )
    .limit(limit);
  return rows as SubscriptionRow[];
}

export async function markPreRenewalReminderSent(
  d1: D1Database,
  id: string,
): Promise<void> {
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({ preRenewalEmailSentAt: new Date(), updatedAt: new Date() })
    .where(eq(subscriptions.id, id));
}

export async function listOverdueDunning(
  d1: D1Database,
  now: Date = new Date(),
  limit: number = RENEWAL_TICK_BATCH_SIZE,
): Promise<Array<{
  id: number;
  subscriptionId: string;
  chargeId: string;
  retryCount: number;
}>> {
  const db = getDb(d1);
  const rows = await db
    .select({
      id: dunningAttempts.id,
      subscriptionId: dunningAttempts.subscriptionId,
      chargeId: dunningAttempts.chargeId,
      retryCount: dunningAttempts.retryCount,
    })
    .from(dunningAttempts)
    .where(
      and(
        isNull(dunningAttempts.resolvedAt),
        lte(dunningAttempts.nextRetryAt, now),
      ),
    )
    .orderBy(asc(dunningAttempts.nextRetryAt))
    .limit(limit);
  return rows;
}

// ─── Dashboard aggregates ─────────────────────────────────────────────

export interface DashboardMetrics {
  activeCount: number;
  pausedCount: number;
  cancelledCount: number;
  mrrCents: number;
  /** churn % over the trailing 30 days (cancelled / (active_now + cancelled_in_window)). */
  churnPct: number;
  currencyCode: string;
}

export async function dashboardMetrics(
  d1: D1Database,
  shop: string,
): Promise<DashboardMetrics> {
  const db = getDb(d1);
  const rows = (await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.shop, shop))) as SubscriptionRow[];

  let activeCount = 0;
  let pausedCount = 0;
  let cancelledCount = 0;
  let mrrCents = 0;
  let cancelledLast30 = 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  let currencyCode = "USD";

  for (const r of rows) {
    if (r.currencyCode) currencyCode = r.currencyCode;
    if (r.status === "active") {
      activeCount += 1;
      // Normalise to monthly MRR using cadenceDays. (30 / cadence) * price.
      mrrCents += Math.round((30 / r.cadenceDays) * r.priceCents * r.quantity);
    } else if (r.status === "paused") {
      pausedCount += 1;
    } else if (r.status === "cancelled") {
      cancelledCount += 1;
      if (r.cancelledAt && r.cancelledAt >= thirtyDaysAgo) cancelledLast30 += 1;
    }
  }
  const denom = activeCount + cancelledLast30;
  const churnPct = denom > 0 ? (cancelledLast30 / denom) * 100 : 0;
  return { activeCount, pausedCount, cancelledCount, mrrCents, churnPct, currencyCode };
}
