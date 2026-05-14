import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { eq, and } from "drizzle-orm";
import { getDb, schema } from "~/lib/db/client.server";

interface ProductDeletePayload {
  id: number;
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return new Response("OK (no D1)", { status: 200 });
  const p = payload as ProductDeletePayload;
  if (!p.id) return new Response("Bad payload", { status: 400 });
  const remoteId = "gid://shopify/Product/" + p.id;
  const db = getDb(env.D1);
  await db
    .delete(schema.products)
    .where(and(eq(schema.products.shop, shop), eq(schema.products.remoteId, remoteId)));
  return new Response("OK", { status: 200 });
};

export default handler;
