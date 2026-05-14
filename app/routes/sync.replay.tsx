import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import { eq, and } from "drizzle-orm";
import { getDb, schema } from "~/lib/db/client.server";
import { upsertResource } from "~/lib/sync.server";

type SyncResource = "products" | "variants" | "orders";

interface ReplayBody {
  dlqId: number;
}

export async function action({ context, request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method Not Allowed" }, { status: 405 });
  }
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

  let body: ReplayBody;
  try {
    body = (await request.json()) as ReplayBody;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.dlqId !== "number") {
    return Response.json({ ok: false, error: "Missing dlqId" }, { status: 400 });
  }

  const db = getDb(env.D1);
  const rows = await db
    .select()
    .from(schema.syncDeadLetter)
    .where(eq(schema.syncDeadLetter.id, body.dlqId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return Response.json({ ok: false, error: "DLQ row not found" }, { status: 404 });
  }
  if (row.resolvedAt) {
    return Response.json({ ok: true, alreadyResolved: true });
  }

  const resource = row.resource as SyncResource;
  const remoteId = row.remoteId;
  const payload = row.payload as Record<string, unknown> | null;
  if (!remoteId || !payload) {
    // Can't replay without enough context. Mark resolved to drop off the
    // queue — the next webhook for this resource will rebuild the row.
    await db
      .update(schema.syncDeadLetter)
      .set({ resolvedAt: new Date() })
      .where(eq(schema.syncDeadLetter.id, body.dlqId));
    return Response.json({ ok: true, droppedAsUnreplayable: true });
  }

  try {
    await upsertResource(env.D1, {
      shop: row.shop,
      resource,
      remoteId,
      remoteUpdatedAt: typeof payload.updated_at === "string" ? payload.updated_at : new Date().toISOString(),
      row: payload,
    });
    await db
      .update(schema.syncDeadLetter)
      .set({ resolvedAt: new Date() })
      .where(eq(schema.syncDeadLetter.id, body.dlqId));
    return Response.json({ ok: true, replayed: true });
  } catch (err) {
    const minutes = Math.min(60, Math.pow(2, row.retryCount + 1));
    await db
      .update(schema.syncDeadLetter)
      .set({
        retryCount: row.retryCount + 1,
        nextRetryAt: new Date(Date.now() + minutes * 60_000),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.syncDeadLetter.id, body.dlqId));
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        retryCount: row.retryCount + 1,
      },
      { status: 500 },
    );
  }
}

// GET on the replay route is a no-op so accidental browser visits
// return a clean 405 instead of leaking the auth-required state.
export function loader() {
  return new Response("Method Not Allowed", { status: 405 });
}
