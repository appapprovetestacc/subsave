import type { CronHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { eq, lte, isNull, and } from "drizzle-orm";
import { LATEST_API_VERSION } from "~/lib/shopify.server";
import {
  productsBackfillQuery, variantsBackfillQuery, ordersBackfillQuery,
  productNodeToRow, variantNodeToRow, orderNodeToRow,
  ProductNode, VariantNode, OrderNode,
  SYNC_BACKFILL_PAGE_SIZE,
} from "~/lib/sync/backfill-queries";
import { getDb, schema } from "~/lib/db/client.server";
import { fetchCursor, saveCursor, upsertResource } from "~/lib/sync.server";
import { captureSetupStep } from "~/lib/merchant-qa.server";

// Sync backfill driver. Fires on the schedule registered in
// appapprove.config.ts crons + wrangler.toml [triggers]. Each tick:
//   1. Drains overdue dead-letter rows (Phase 3.7 C — automatic retry).
//   2. Processes one page per resource for every shop with an active
//      session, persisting cursor state for resumability.
// Total per-tick budget is bounded by CF Workers' scheduled-event time
// limit (~30s on free tier, longer on paid).
const handler: CronHandler = async ({ context, scheduledAt }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  const d1 = env.D1;
  if (!d1) {
    console.warn("[sync-backfill] D1 binding missing — skipping");
    return;
  }

  // ─── Drain overdue DLQ rows ────────────────────────────────────────
  const dlqDrained = await drainDeadLetters(env, scheduledAt);
  if (dlqDrained > 0) {
    console.log("[sync-backfill] drained " + dlqDrained + " DLQ row(s)");
  }

  // ─── Backfill loop ─────────────────────────────────────────────────
  // shopify-app-remix doesn't expose "list all installed shops" out of
  // the box; the scaffold ships a session-storage helper that does. We
  // load the offline access token per shop and construct a minimal
  // admin GraphQL client inline (no `unauthenticated.admin()` helper —
  // the scaffold's auth layer doesn't depend on shopify-app-remix's
  // session storage abstraction).
  const shops = await listInstalledShops(env);
  for (const shop of shops) {
    const accessToken = await loadOfflineAccessToken(env, shop);
    if (!accessToken) {
      console.warn("[sync-backfill] no offline session for " + shop + " — skipping");
      continue;
    }
    const admin = adminClient(shop, accessToken);
    for (const resource of SYNC_RESOURCES_PICKED) {
      const cur = await fetchCursor(d1, shop, resource);
      // Skip resources whose cursor is "idle" + has a lastSyncedAt — the
      // backfill is complete and live updates flow through webhooks.
      if (cur && cur.status === "idle" && cur.lastSyncedAt) continue;
      const cursor: string | null = cur?.cursor ?? null;
      // Phase 3 hardening — fire setup-step on the first sync tick of
      // each (shop, resource) so the AppApprove timeline shows when a
      // backfill kicked off. Subsequent ticks skip (cur is non-null + non-idle).
      if (!cur) {
        await captureSetupStep(env, "sync_backfill_started", { shop, resource });
      }
      try {
        const result = await fetchPage(admin, env, shop, resource, cursor);
        await saveCursor(
          d1,
          shop,
          resource,
          result.endCursor,
          result.hasNextPage ? "running" : "idle",
          null,
        );
        // Phase 3 hardening — fire setup-step when a (shop, resource)
        // backfill completes (transitions running → idle).
        if (!result.hasNextPage) {
          await captureSetupStep(env, "sync_backfill_completed", { shop, resource });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[sync-backfill] " + shop + "/" + resource + " failed: " + msg);
        await saveCursor(d1, shop, resource, cursor, "failed", msg);
        // Phase 3 hardening — fire setup-step on backfill failure so
        // the timeline shows the regression alongside the cursor's
        // status flip to "failed".
        await captureSetupStep(env, "sync_backfill_failed", {
          shop,
          resource,
          error: msg.slice(0, 200),
        });
      }
    }
  }
  console.log("[sync-backfill] tick complete at " + new Date(scheduledAt).toISOString());
};

// Reads up to N overdue DLQ rows, re-runs each via upsertResource(),
// marks resolved on success or bumps retry_count + reschedules on
// failure. Capped per-tick to avoid eating the whole 30s budget on a
// large DLQ — leftover rows roll into the next tick.
const DLQ_DRAIN_BATCH_SIZE = 25;
async function drainDeadLetters(env: Env, now: number): Promise<number> {
  const db = getDb(env.D1!);
  const overdue = await db
    .select()
    .from(schema.syncDeadLetter)
    .where(
      and(
        isNull(schema.syncDeadLetter.resolvedAt),
        lte(schema.syncDeadLetter.nextRetryAt, new Date(now)),
      ),
    )
    .limit(DLQ_DRAIN_BATCH_SIZE);
  let drained = 0;
  for (const row of overdue) {
    if (!row.remoteId || !row.payload) {
      await db
        .update(schema.syncDeadLetter)
        .set({ resolvedAt: new Date() })
        .where(eq(schema.syncDeadLetter.id, row.id));
      drained++;
      continue;
    }
    const payload = row.payload as Record<string, unknown>;
    try {
      await upsertResource(env.D1!, {
        shop: row.shop,
        resource: row.resource as Resource,
        remoteId: row.remoteId,
        remoteUpdatedAt: typeof payload.updated_at === "string" ? payload.updated_at : new Date().toISOString(),
        row: payload,
      });
      await db
        .update(schema.syncDeadLetter)
        .set({ resolvedAt: new Date() })
        .where(eq(schema.syncDeadLetter.id, row.id));
      drained++;
    } catch (err) {
      const minutes = Math.min(60, Math.pow(2, row.retryCount + 1));
      await db
        .update(schema.syncDeadLetter)
        .set({
          retryCount: row.retryCount + 1,
          nextRetryAt: new Date(Date.now() + minutes * 60_000),
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(schema.syncDeadLetter.id, row.id));
    }
  }
  return drained;
}


const SYNC_RESOURCES_PICKED = ["products", "variants", "orders"] as const;
type Resource = (typeof SYNC_RESOURCES_PICKED)[number];

interface PageResult {
  hasNextPage: boolean;
  endCursor: string | null;
}

async function fetchPage(
  admin: { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  env: Env,
  shop: string,
  resource: Resource,
  cursor: string | null,
): Promise<PageResult> {
  switch (resource) {
    case "products": {
      const res = await admin.graphql(productsBackfillQuery, { variables: { first: SYNC_BACKFILL_PAGE_SIZE, after: cursor } });
      const data = (await res.json()) as { data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ProductNode[] } } };
      const conn = data.data.products;
      for (const node of conn.nodes) {
        await upsertResource(env.D1!, {
          shop,
          resource: "products",
          remoteId: node.id,
          remoteUpdatedAt: node.updatedAt,
          row: productNodeToRow(shop, node, ""),
        });
      }
      return { hasNextPage: conn.pageInfo.hasNextPage, endCursor: conn.pageInfo.endCursor };
    }
    case "variants": {
      const res = await admin.graphql(variantsBackfillQuery, { variables: { first: SYNC_BACKFILL_PAGE_SIZE, after: cursor } });
      const data = (await res.json()) as { data: { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: VariantNode[] } } };
      const conn = data.data.productVariants;
      for (const node of conn.nodes) {
        await upsertResource(env.D1!, {
          shop,
          resource: "variants",
          remoteId: node.id,
          remoteUpdatedAt: node.updatedAt,
          row: variantNodeToRow(shop, node, ""),
        });
      }
      return { hasNextPage: conn.pageInfo.hasNextPage, endCursor: conn.pageInfo.endCursor };
    }
    case "orders": {
      const res = await admin.graphql(ordersBackfillQuery, { variables: { first: SYNC_BACKFILL_PAGE_SIZE, after: cursor } });
      const data = (await res.json()) as { data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: OrderNode[] } } };
      const conn = data.data.orders;
      for (const node of conn.nodes) {
        await upsertResource(env.D1!, {
          shop,
          resource: "orders",
          remoteId: node.id,
          remoteUpdatedAt: node.updatedAt,
          row: orderNodeToRow(shop, node, ""),
        });
      }
      return { hasNextPage: conn.pageInfo.hasNextPage, endCursor: conn.pageInfo.endCursor };
    }
    default: {
      const _exhaustive: never = resource;
      throw new Error("Unhandled resource: " + (_exhaustive as string));
    }
  }
}

// Lists shops that have an offline session in the session-storage KV.
// The scaffold's `session-storage.server.ts` writes one entry per shop
// at install time with a known prefix. If you've customised the storage
// layer, update this listing to match.
async function listInstalledShops(env: Env): Promise<string[]> {
  const ns = env.SESSIONS;
  if (!ns) return [];
  const list = await ns.list({ prefix: "offline:" });
  const shops: string[] = [];
  for (const k of list.keys) {
    const m = k.name.match(/^offline:(.+)$/);
    if (m && m[1]) shops.push(m[1]);
  }
  return Array.from(new Set(shops));
}

async function loadOfflineAccessToken(env: Env, shop: string): Promise<string | null> {
  const ns = env.SESSIONS;
  if (!ns) return null;
  const raw = await ns.get("offline:" + shop);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as { accessToken?: string };
    return session.accessToken ?? null;
  } catch {
    return null;
  }
}

function adminClient(shop: string, accessToken: string): {
  graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
} {
  return {
    graphql: (q, opts) =>
      fetch("https://" + shop + "/admin/api/" + LATEST_API_VERSION + "/graphql.json", {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: q, variables: opts?.variables ?? {} }),
      }),
  };
}

export default handler;
