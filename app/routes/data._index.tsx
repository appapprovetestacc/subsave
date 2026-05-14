import { json, redirect, type LoaderFunctionArgs } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";
import { count, eq } from "drizzle-orm";
import type { Env } from "../../load-context";
import { isValidShop } from "~/lib/shopify.server";
import { loadOfflineSession } from "~/lib/session-storage.server";
import { getDb, schema } from "~/lib/db/client.server";

// Index of synced tables. Per-table pages live at /data/<resource>.
// Counts are scoped to the requested shop's offline session — without
// the shop filter this would leak cross-tenant row counts.

export async function loader({ context, request }: LoaderFunctionArgs) {
  // Offline-session auth — same pattern as the per-resource pages. The
  // embedded admin URL carries ?shop=<store>.myshopify.com; if no
  // persisted OAuth session exists we redirect to /auth to install.
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  if (!shopParam || !isValidShop(shopParam)) {
    throw new Response("Missing or invalid ?shop", { status: 400 });
  }
  const session = await loadOfflineSession(context, shopParam);
  if (!session) throw redirect("/auth?shop=" + encodeURIComponent(shopParam));
  const shop = shopParam;
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) throw json({ error: "D1 binding missing" }, { status: 503 });
  const db = getDb(env.D1);
  const counts = {
      products: await db.select({ value: count() }).from(schema.products).where(eq(schema.products.shop, shop)).then((r) => r[0]?.value ?? 0),
      productVariants: await db.select({ value: count() }).from(schema.productVariants).where(eq(schema.productVariants.shop, shop)).then((r) => r[0]?.value ?? 0),
      orders: await db.select({ value: count() }).from(schema.orders).where(eq(schema.orders.shop, shop)).then((r) => r[0]?.value ?? 0),
  };
  return json({ shop, counts });
}

export default function DataIndexRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
      <h1>Synced data</h1>
      <p style={{ color: "#666" }}>
        Browse the local mirror of Shopify resources for <code>{data.shop}</code>.
        Click a table to view its rows.
      </p>
      <ul style={{ listStyle: "none", padding: 0, lineHeight: 2 }}>
        <li><Link to="/data/products">Products</Link> — {data.counts.products} rows</li>
        <li><Link to="/data/variants">Product variants</Link> — {data.counts.productVariants} rows</li>
        <li><Link to="/data/orders">Orders</Link> — {data.counts.orders} rows</li>
      </ul>
      <h2 style={{ marginTop: "2rem" }}>App-owned tables</h2>
      <p>
        See <code>app/lib/db/app-tables.server.ts</code> for the CRUD pattern
        on tables your app owns end-to-end (settings, custom records, etc.).
      </p>
    </main>
  );
}
