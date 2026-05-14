# Data sync (Phase 3.7)

This app ships a managed sync layer for: **products, variants, orders**. It
gives you a local mirror of selected Shopify resources backed by
Cloudflare D1, plus the helpers needed to keep that mirror up to date.

## Files

- `app/lib/db/schema.server.ts` — Drizzle table definitions (one table
  per resource + shared `sync_cursors` and `sync_dead_letter` tables).
- `app/lib/db/client.server.ts` — `getDb(env.D1)` returns a typed
  Drizzle client.
- `app/lib/sync.server.ts` — payload-hash dedupe, idempotent
  `upsertResource()`, cursor get/set, dead-letter recording.
- `app/lib/sync/backfill-queries.ts` — typed GraphQL queries with cursor
  pagination + node-to-row mappers for each picked resource.
- `migrations/0001_init_sync.sql` — initial schema migration applied by
  the deploy workflow.
- `drizzle.config.ts` — Drizzle Kit config. Run `pnpm db:generate` after
  schema edits to emit `migrations/0002_*.sql`.

## Provisioning the D1 binding

The AppApprove deploy pipeline auto-provisions the D1 database on first
deploy and injects the binding. To run locally:

```bash
pnpm dlx wrangler d1 create $WRANGLER_NAME-db
# Copy the printed database_id into wrangler.toml's [[d1_databases]]
# block (the scaffold ships it commented out), then:
pnpm db:migrate
```

## Backfill loop (sketch)

```ts
import { fetchCursor, saveCursor, upsertResource } from "~/lib/sync.server";
import { productBackfillQuery, productNodeToRow } from "~/lib/sync/backfill-queries";

await saveCursor(env.D1, shop, "products", null, "running");
let cursor: string | null = null;
do {
  const res = await admin.graphql(productBackfillQuery, {
    variables: { first: 50, after: cursor },
  });
  const data = (await res.json()).data.products;
  for (const node of data.nodes) {
    await upsertResource(env.D1, {
      shop, resource: "products", remoteId: node.id,
      remoteUpdatedAt: node.updatedAt,
      row: productNodeToRow(shop, node, ""),
    });
  }
  cursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
  await saveCursor(env.D1, shop, "products", cursor, cursor ? "running" : "idle");
} while (cursor);
```

## Webhook upserts

For each resource webhook (e.g. `products/update`), parse the payload,
map it to a row shape, and call `upsertResource()`. The payload-hash
check skips writes when Shopify replays the same event.

## GDPR redaction

`customers/redact` should call `redactSyncPayload()` on the stored
payload, set `redacted_at = now()`, and remove the email/firstName/
lastName/tags columns. Don't `DELETE` the row — keeping the tombstone
prevents Shopify webhook replays from re-creating the customer.
