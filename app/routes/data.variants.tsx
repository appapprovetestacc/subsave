import { json, redirect, type LoaderFunctionArgs } from "@remix-run/cloudflare";
import { Link, useLoaderData, useSearchParams } from "@remix-run/react";
import type { Env } from "../../load-context";
import { isValidShop } from "~/lib/shopify.server";
import { loadOfflineSession } from "~/lib/session-storage.server";
import { listProductVariants } from "~/lib/sync/api/variants.server";

// Read-only browser for the synced "variants" table. Pagination + search
// via query params (?q=, ?page=). Auth is via the offline-session pattern:
// the embedded admin URL carries ?shop=, we validate it and resolve the
// persisted OAuth session before any D1 read so cross-tenant data never
// leaks. Writes intentionally NOT exposed — Shopify is the source of
// truth for resource state, so any modification must round-trip through
// the Admin API (use a separate Remix route for that). For app-owned
// data (where the merchant app IS the source of truth), see
// app/lib/db/app-tables.server.ts for the CRUD pattern.

const PAGE_SIZE = 50;

export async function loader({ context, request }: LoaderFunctionArgs) {
  // Offline-session auth. Validate ?shop and reject anything that isn't
  // a real myshopify.com hostname before touching D1; if there's no
  // persisted session for the shop, kick to /auth to install.
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
  const q = url.searchParams.get("q") ?? "";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const result = await listProductVariants(env.D1, {
    shop,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    ...(q ? { search: q } : {}),
  });
  return json({ ...result, shop, q, page, pageSize: PAGE_SIZE });
}

export default function ProductVariantsDataRoute() {
  const data = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 1200 }}>
      <Link to="/data">← All data</Link>
      <h1 style={{ marginTop: "1rem" }}>Product variants</h1>
      <p style={{ color: "#666", fontSize: "0.75rem", marginTop: "0.25rem" }}>
        Shop: <code>{data.shop}</code> (from session)
      </p>
      <form method="get" style={{ display: "flex", gap: "0.5rem", margin: "1rem 0" }}>
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="search"
          style={{ flex: 2, padding: "0.5rem" }}
        />
        <button type="submit">Filter</button>
      </form>
      <p style={{ color: "#666", fontSize: "0.875rem" }}>
        {data.total} rows · page {data.page} of {totalPages}
      </p>
      {data.rows.length === 0 ? (
        <p>No rows for {data.shop} yet — backfill cron will populate within a few minutes.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead style={{ background: "#f5f5f5" }}>
            <tr>
              <th className="px-3 py-2 text-left">remoteId</th>
              <th className="px-3 py-2 text-left">sku</th>
              <th className="px-3 py-2 text-left">price</th>
              <th className="px-3 py-2 text-left">inventoryQuantity</th>
              <th className="px-3 py-2 text-left">remoteUpdatedAt</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.remoteId} style={{ borderBottom: "1px solid #eee" }}>
                <td className="px-3 py-2 font-mono text-xs">{formatCell(row.remoteId)}</td>
                <td className="px-3 py-2 font-mono text-xs">{formatCell(row.sku)}</td>
                <td className="px-3 py-2 font-mono text-xs">{formatCell(row.price)}</td>
                <td className="px-3 py-2 font-mono text-xs">{formatCell(row.inventoryQuantity)}</td>
                <td className="px-3 py-2 font-mono text-xs">{formatCell(row.remoteUpdatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {totalPages > 1 ? (
        <nav style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          {data.page > 1 ? (
            <Link to={pageHref(q, data.page - 1)}>← Prev</Link>
          ) : null}
          {data.page < totalPages ? (
            <Link to={pageHref(q, data.page + 1)}>Next →</Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}

function pageHref(q: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("page", String(page));
  return "?" + params.toString();
}

function formatCell(value: unknown): string {
  if (value == null) return "—";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value).slice(0, 100);
  return String(value);
}
