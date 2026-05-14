import { json, type LoaderFunctionArgs } from "@remix-run/cloudflare";
import { Link, useLoaderData, useSearchParams } from "@remix-run/react";
import type { Env } from "../../load-context";
import { authenticate } from "~/lib/shopify.server";
import { listProductVariants } from "~/lib/sync/api/variants.server";

// Read-only browser for the synced "variants" table. Pagination + search
// via query params (?q=, ?page=). The shop is derived from the embedded-
// admin session — never trust a ?shop= query param for cross-tenant access.
// Writes intentionally NOT exposed — Shopify is the source of truth for
// resource state, so any modification must round-trip through the Admin
// API (use a separate Remix route for that). For app-owned data (where
// the merchant app IS the source of truth), see app/lib/db/
// app-tables.server.ts for the CRUD pattern.

const PAGE_SIZE = 50;

export async function loader({ context, request }: LoaderFunctionArgs) {
  // Phase 3 hardening — embedded-admin session required. Without this
  // gate any anonymous visitor with the URL pattern + ?shop= could read
  // every shop's mirrored data. authenticate.admin throws a 401 Response
  // when the session token is missing/invalid, which Remix surfaces as
  // a clean error page (App Bridge re-issues the token on retry).
  const { shop } = await authenticate.admin(request, context);
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) throw json({ error: "D1 binding missing" }, { status: 503 });
  const url = new URL(request.url);
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
