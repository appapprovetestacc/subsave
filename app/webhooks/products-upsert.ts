import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { upsertResource, recordDeadLetter } from "~/lib/sync.server";

interface ShopifyProductPayload {
  admin_graphql_api_id: string;
  title: string;
  handle: string | null;
  status: string | null;
  updated_at: string;
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) {
    console.warn("[sync] products webhook fired but D1 binding missing");
    return new Response("OK (no D1)", { status: 200 });
  }
  const p = payload as ShopifyProductPayload;
  if (!p.admin_graphql_api_id) {
    return new Response("Bad payload", { status: 400 });
  }
  try {
    await upsertResource(env.D1, {
      shop,
      resource: "products",
      remoteId: p.admin_graphql_api_id,
      remoteUpdatedAt: p.updated_at,
      row: {
        remoteId: p.admin_graphql_api_id,
        shop,
        title: p.title,
        handle: p.handle,
        status: p.status,
        payload: p as unknown as Record<string, unknown>,
        remoteUpdatedAt: p.updated_at,
      },
    });
  } catch (err) {
    await recordDeadLetter(env.D1, {
      shop,
      resource: "products",
      remoteId: p.admin_graphql_api_id,
      payload: p as unknown as Record<string, unknown>,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return new Response("OK", { status: 200 });
};

export default handler;
