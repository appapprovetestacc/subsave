// SubSave outbound email — thin Resend wrapper used by the renewals
// cron and admin actions. Pulls RESEND_API_KEY from env (declared in
// load-context.ts Env interface).
//
// Falls back to the richer BYOK/AppApprove proxy in app/lib/mail.server.ts
// when no API key is set — that keeps test/dev environments deliverable
// without forcing the merchant to set up Resend immediately.
//
// Templates live next to the sender: each renderer returns { subject,
// html, text } so callers can pick the delivery channel.

import type { Env } from "../../load-context";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Optional reply-to (merchant's support inbox). */
  replyTo?: string;
  /** Resend tags, e.g. [{name:"flow",value:"pre-renewal"}]. */
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;

export async function sendEmail(env: Env, input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    // Soft-fail: log + return error without throwing. Cron flows treat
    // a delivery error as non-fatal — the next tick re-attempts.
    console.warn("[email] RESEND_API_KEY missing — skipping send to " + input.to);
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  const from = env.MAIL_SENDER_FROM ?? "SubSave <noreply@apps.appapprove.com>";
  const body = JSON.stringify({
    from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    ...(input.text ? { text: input.text } : {}),
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
  });
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: "Resend HTTP " + res.status + ": " + text.slice(0, 300) };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: json.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Templates ────────────────────────────────────────────────────────

export interface SubscriptionSummary {
  productTitle?: string;
  amountCents: number;
  currencyCode: string;
  nextRenewalAt: Date;
  manageUrl?: string;
}

function fmtMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return amount + " " + currency;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function renderPreRenewalReminder(s: SubscriptionSummary): {
  subject: string;
  html: string;
  text: string;
} {
  const product = s.productTitle ?? "your subscription";
  const subject = "Heads up: " + product + " renews on " + fmtDate(s.nextRenewalAt);
  const amount = fmtMoney(s.amountCents, s.currencyCode);
  const manageLine = s.manageUrl
    ? "<p>Manage your subscription: <a href=\"" + s.manageUrl + "\">" + s.manageUrl + "</a></p>"
    : "";
  const html =
    "<p>This is a friendly reminder that " + product + " will renew on " +
    fmtDate(s.nextRenewalAt) + ". You'll be charged " + amount + ".</p>" +
    "<p>Need to skip this delivery, pause, or cancel? You can do that from your account.</p>" +
    manageLine;
  const text =
    "Reminder: " + product + " renews on " + fmtDate(s.nextRenewalAt) +
    " for " + amount + ".\n" +
    (s.manageUrl ? "Manage: " + s.manageUrl : "");
  return { subject, html, text };
}

export function renderDunningNotice(
  s: SubscriptionSummary,
  attempt: number,
): { subject: string; html: string; text: string } {
  const product = s.productTitle ?? "your subscription";
  const subject =
    "We couldn't charge your card for " + product + " (attempt " + attempt + ")";
  const amount = fmtMoney(s.amountCents, s.currencyCode);
  const manageLine = s.manageUrl
    ? "<p>Update your payment method: <a href=\"" + s.manageUrl + "\">" + s.manageUrl + "</a></p>"
    : "";
  const html =
    "<p>We weren't able to process the " + amount + " charge for " + product + ".</p>" +
    "<p>We'll automatically retry shortly. To avoid an interruption, please update your payment method.</p>" +
    manageLine;
  const text =
    "We couldn't charge " + amount + " for " + product + ". We'll retry, but please update your payment method to avoid interruption." +
    (s.manageUrl ? "\nUpdate: " + s.manageUrl : "");
  return { subject, html, text };
}

export function renderCancellationNotice(s: SubscriptionSummary): {
  subject: string;
  html: string;
  text: string;
} {
  const product = s.productTitle ?? "your subscription";
  const subject = "Your " + product + " subscription has been cancelled";
  const html =
    "<p>Your " + product + " subscription has been cancelled. No future charges will be made.</p>" +
    "<p>If this wasn't intentional, reply to this email and we'll restore it.</p>";
  const text =
    "Your " + product + " subscription has been cancelled. No future charges will be made.";
  return { subject, html, text };
}
