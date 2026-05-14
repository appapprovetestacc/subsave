import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client.server";
import { subscriptions } from "~/lib/db/app-tables.schema.server";

// SubSave — customers/create. The renewals cron sends customer-facing
// emails (pre-renewal reminders, dunning). When a customer is created
// without an email on the original subscription row, this webhook
// back-fills it so future tick emails have a recipient.
//
// We intentionally do NOT create a subscription here — that's a
// merchant-initiated action through the admin UI (or, when Sprint 26
// ships, a checkout-attribute flow on orders/create).

interface ShopifyCustomerPayload {
  admin_graphql_api_id: string;
  email: string | null;
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return new Response("OK (no D1)", { status: 200 });
  const p = payload as ShopifyCustomerPayload;
  if (!p.admin_graphql_api_id || !p.email) {
    return new Response("OK (no-op)", { status: 200 });
  }
  const db = getDb(env.D1);
  // Backfill the email on any subscription rows that match this
  // customer but were missing the contact (e.g. imported records).
  await db
    .update(subscriptions)
    .set({ customerEmail: p.email, updatedAt: new Date() })
    .where(eq(subscriptions.customerRemoteId, p.admin_graphql_api_id));
  return new Response("OK", { status: 200 });
};

export default handler;
