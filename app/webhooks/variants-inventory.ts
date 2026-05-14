import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { eq, and } from "drizzle-orm";
import { getDb, schema } from "~/lib/db/client.server";

// inventory_levels/update fires when a variant's stock at a location
// changes. Shopify includes inventory_item_id (not the variant gid), so
// we update inventory_items if that table exists, and best-effort patch
// product_variants by querying the InventoryItem -> Variant relation
// (skipped here — the source-of-truth column is inventory_quantity on
// the variant, kept current via products/update fanout).

interface InventoryLevelPayload {
  inventory_item_id: number;
  available: number;
  location_id: number;
  updated_at: string;
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return new Response("OK (no D1)", { status: 200 });
  const p = payload as InventoryLevelPayload;
  if (!p.inventory_item_id) return new Response("Bad payload", { status: 400 });
  // The inventoryItems table is only present when the wizard picked
  // `inventory_items` as a sync resource. If it's missing the variant's
  // inventoryQuantity stays in sync via the products/update fanout —
  // skip silently rather than erroring on a missing table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inv = (schema as any).inventoryItems;
  if (!inv) return new Response("OK (no inventory_items table)", { status: 200 });
  const remoteId = "gid://shopify/InventoryItem/" + p.inventory_item_id;
  const db = getDb(env.D1);
  // Update inventory_items.payload to reflect the latest level — the
  // payload column already holds the JSON shape from the backfill.
  const existing = await db
    .select()
    .from(inv)
    .where(and(eq(inv.shop, shop), eq(inv.remoteId, remoteId)))
    .limit(1);
  if (existing[0]) {
    const patched = { ...existing[0].payload, lastLevel: p } as Record<string, unknown>;
    await db
      .update(inv)
      .set({ payload: patched, syncedAt: new Date(), remoteUpdatedAt: p.updated_at })
      .where(and(eq(inv.shop, shop), eq(inv.remoteId, remoteId)));
  }
  return new Response("OK", { status: 200 });
};

export default handler;
