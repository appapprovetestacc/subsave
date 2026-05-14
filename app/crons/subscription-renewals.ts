import type { CronHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "~/lib/db/client.server";
import { subscriptionCharges } from "~/lib/db/app-tables.schema.server";
import {
  advanceAfterSuccess,
  advanceForSkip,
  attemptCharge,
  bumpDunning,
  cancelSubscription,
  getSubscription,
  listDueRenewals,
  listOverdueDunning,
  listSubscriptionsNeedingReminder,
  markPreRenewalReminderSent,
  MAX_DUNNING_RETRIES,
  openDunning,
  resolveDunning,
  type SubscriptionRow,
} from "~/lib/subscriptions.server";
import {
  renderCancellationNotice,
  renderDunningNotice,
  renderPreRenewalReminder,
  sendEmail,
} from "~/lib/email.server";
import { captureSetupStep } from "~/lib/merchant-qa.server";

// SubSave — renewals sweep. Three phases per tick:
//   1. Pre-renewal reminders (3 days out) — send once per cycle.
//   2. Due renewals — charge active subscriptions whose nextRenewalAt
//      has passed. Skip-next-renewal flag honored (advance without
//      charging). Failed charges open a dunning row.
//   3. Overdue dunning — retry failed charges with exponential backoff.
//      After MAX_DUNNING_RETRIES, auto-cancel the subscription.
//
// Per-tick work is bounded by RENEWAL_TICK_BATCH_SIZE (50). Anything
// not handled in this tick rolls into the next one.

const handler: CronHandler = async ({ context, scheduledAt }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  const d1 = env.D1;
  if (!d1) {
    console.warn("[subscription-renewals] D1 binding missing — skipping");
    return;
  }
  const now = new Date(scheduledAt);

  // ─── Phase 1: pre-renewal reminders ──────────────────────────────
  const remindable = await listSubscriptionsNeedingReminder(d1, undefined, now);
  for (const sub of remindable) {
    if (!sub.customerEmail) {
      // No email on file — mark as sent so we don't retry every tick.
      await markPreRenewalReminderSent(d1, sub.id);
      continue;
    }
    const title = await loadProductTitle(d1, sub);
    const tpl = renderPreRenewalReminder({
      productTitle: title,
      amountCents: sub.priceCents * sub.quantity,
      currencyCode: sub.currencyCode,
      nextRenewalAt: sub.nextRenewalAt,
    });
    const result = await sendEmail(env, {
      to: sub.customerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      tags: [
        { name: "flow", value: "pre-renewal" },
        { name: "subscription_id", value: sub.id },
      ],
    });
    if (result.ok) {
      await markPreRenewalReminderSent(d1, sub.id);
    } else {
      console.warn(
        "[subscription-renewals] pre-renewal email failed for " + sub.id + ": " + result.error,
      );
    }
  }

  // ─── Phase 2: due renewals ───────────────────────────────────────
  const due = await listDueRenewals(d1, now);
  for (const sub of due) {
    if (sub.skipNextRenewal) {
      await advanceForSkip(d1, sub);
      continue;
    }
    const { charge, chargeRowId } = await attemptCharge(d1, sub);
    if (charge.ok) {
      await advanceAfterSuccess(d1, sub);
    } else {
      const msg = charge.failureMessage ?? charge.failureCode ?? "Unknown charge failure";
      await openDunning(d1, sub, chargeRowId, msg);
      await sendDunningEmail(env, sub, 1);
    }
  }

  // ─── Phase 3: overdue dunning retries ────────────────────────────
  const overdue = await listOverdueDunning(d1, now);
  for (const attempt of overdue) {
    const sub = await getSubscription(d1, attempt.subscriptionId);
    if (!sub || sub.status !== "active") {
      await resolveDunning(d1, attempt.id, "manual");
      continue;
    }
    const { charge, chargeRowId } = await attemptCharge(d1, sub);
    if (charge.ok) {
      await advanceAfterSuccess(d1, sub);
      await resolveDunning(d1, attempt.id, "charge_succeeded");
      continue;
    }
    const nextRetryNumber = attempt.retryCount + 1;
    if (nextRetryNumber >= MAX_DUNNING_RETRIES) {
      await cancelSubscription(d1, sub.id, "dunning_exhausted");
      await resolveDunning(d1, attempt.id, "auto_cancelled");
      await sendCancellationEmail(env, sub);
      await captureSetupStep(env, "subscription_auto_cancelled", {
        shop: sub.shop,
        subscriptionId: sub.id,
      });
    } else {
      const msg = charge.failureMessage ?? charge.failureCode ?? "Charge retry failed";
      await bumpDunning(d1, attempt.id, attempt.retryCount, msg);
      // Mark the latest charge row as failed so the QA timeline can
      // surface the attempt count alongside the dunning state.
      const db = getDb(d1);
      await db
        .update(subscriptionCharges)
        .set({ status: "failed", failureMessage: msg })
        .where(eq(subscriptionCharges.id, chargeRowId));
      await sendDunningEmail(env, sub, nextRetryNumber + 1);
    }
  }

  console.log(
    "[subscription-renewals] tick complete @ " + now.toISOString() +
      " (reminders=" + remindable.length +
      " renewals=" + due.length +
      " dunning=" + overdue.length + ")",
  );
};

async function loadProductTitle(
  d1: Parameters<typeof getDb>[0],
  sub: SubscriptionRow,
): Promise<string | undefined> {
  const db = getDb(d1);
  const rows = await db
    .select({ title: schema.products.title })
    .from(schema.products)
    .where(
      and(
        eq(schema.products.shop, sub.shop),
        eq(schema.products.remoteId, sub.productRemoteId),
      ),
    )
    .limit(1);
  return rows[0]?.title;
}

async function sendDunningEmail(
  env: Env,
  sub: SubscriptionRow,
  attemptNumber: number,
): Promise<void> {
  if (!sub.customerEmail) return;
  const tpl = renderDunningNotice(
    {
      amountCents: sub.priceCents * sub.quantity,
      currencyCode: sub.currencyCode,
      nextRenewalAt: sub.nextRenewalAt,
    },
    attemptNumber,
  );
  await sendEmail(env, {
    to: sub.customerEmail,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    tags: [
      { name: "flow", value: "dunning" },
      { name: "subscription_id", value: sub.id },
      { name: "attempt", value: String(attemptNumber) },
    ],
  });
}

async function sendCancellationEmail(env: Env, sub: SubscriptionRow): Promise<void> {
  if (!sub.customerEmail) return;
  const tpl = renderCancellationNotice({
    amountCents: sub.priceCents * sub.quantity,
    currencyCode: sub.currencyCode,
    nextRenewalAt: sub.nextRenewalAt,
  });
  await sendEmail(env, {
    to: sub.customerEmail,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    tags: [
      { name: "flow", value: "cancellation" },
      { name: "subscription_id", value: sub.id },
    ],
  });
}

export default handler;
