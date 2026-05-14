import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { upsertResource, recordDeadLetter } from "~/lib/sync.server";

// SubSave — orders/create. Sprint 26 will detect cart attributes
// (e.g. _subsave_cadence) on checkout and call createSubscription()
// here. For the initial scaffold this hands off to the standard order
// upsert so the D1 mirror stays consistent — the subscription-creation
// step is exercised manually from the admin dashboard until checkout
// integration ships.

interface ShopifyOrderPayload {
  admin_graphql_api_id: string;
  name: string;
  email: string | null;
  total_price: string | null;
  currency: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  updated_at: string;
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return new Response("OK (no D1)", { status: 200 });
  const p = payload as ShopifyOrderPayload;
  if (!p.admin_graphql_api_id) return new Response("Bad payload", { status: 400 });
  try {
    await upsertResource(env.D1, {
      shop,
      resource: "orders",
      remoteId: p.admin_graphql_api_id,
      remoteUpdatedAt: p.updated_at,
      row: {
        remoteId: p.admin_graphql_api_id,
        shop,
        name: p.name,
        email: p.email,
        totalPrice: p.total_price,
        currencyCode: p.currency,
        financialStatus: p.financial_status,
        fulfillmentStatus: p.fulfillment_status,
        payload: p as unknown as Record<string, unknown>,
        remoteUpdatedAt: p.updated_at,
      },
    });
  } catch (err) {
    await recordDeadLetter(env.D1, {
      shop,
      resource: "orders",
      remoteId: p.admin_graphql_api_id,
      payload: p as unknown as Record<string, unknown>,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return new Response("OK", { status: 200 });
};

export default handler;
