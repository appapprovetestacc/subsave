import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import { isNull } from "drizzle-orm";
import { getDb, schema } from "~/lib/db/client.server";

// Per-shop sync progress JSON. AppApprove polls this from the project
// dashboard (apps/landing) to render "last synced N minutes ago" + the
// running/idle/failed badge per resource. Auth: bearer token sourced
// from env.SYNC_STATUS_TOKEN — pushed in by the AppApprove deploy
// pipeline at first deploy. Without the token bound, the endpoint
// returns 503 (rather than leaking sync state to anonymous callers).
export async function loader({ context, request }: LoaderFunctionArgs) {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) {
    return Response.json({ ok: false, error: "D1 binding missing" }, { status: 503 });
  }
  const expected = env.SYNC_STATUS_TOKEN;
  if (!expected) {
    return Response.json(
      { ok: false, error: "SYNC_STATUS_TOKEN not configured" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== "Bearer " + expected) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const db = getDb(env.D1);
  const cursors = await db.select().from(schema.syncCursors);
  const dlq = await db
    .select({
      id: schema.syncDeadLetter.id,
      shop: schema.syncDeadLetter.shop,
      resource: schema.syncDeadLetter.resource,
      retryCount: schema.syncDeadLetter.retryCount,
      createdAt: schema.syncDeadLetter.createdAt,
      error: schema.syncDeadLetter.error,
      resolvedAt: schema.syncDeadLetter.resolvedAt,
    })
    .from(schema.syncDeadLetter)
    .where(isNull(schema.syncDeadLetter.resolvedAt))
    .limit(20);
  return Response.json({
    ok: true,
    cursors: cursors.map((c) => ({
      shop: c.shop,
      resource: c.resource,
      cursor: c.cursor,
      lastSyncedAt: c.lastSyncedAt ? c.lastSyncedAt.toISOString() : null,
      status: c.status,
      lastError: c.lastError,
    })),
    deadLetter: dlq.map((row) => ({
      id: row.id,
      shop: row.shop,
      resource: row.resource,
      retryCount: row.retryCount,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      error: row.error,
    })),
  });
}
