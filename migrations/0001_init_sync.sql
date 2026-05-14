-- 0001_init_sync.sql — emitted by AppApprove wizard for the resources
-- you picked. Generated; safe to edit by hand once you run `pnpm
-- db:generate` for follow-up changes (Drizzle Kit will diff against the
-- live schema and produce 0002, 0003, …).

CREATE TABLE products (
  remote_id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  title TEXT NOT NULL,
  handle TEXT,
  status TEXT,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  remote_updated_at TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX products_shop_remote_idx ON products(shop, remote_id);
CREATE INDEX products_shop_updated_idx ON products(shop, remote_updated_at);

CREATE TABLE product_variants (
  remote_id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  product_remote_id TEXT NOT NULL REFERENCES products(remote_id) ON DELETE CASCADE,
  sku TEXT,
  price TEXT,
  inventory_quantity INTEGER,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  remote_updated_at TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX variants_shop_remote_idx ON product_variants(shop, remote_id);
CREATE INDEX variants_product_idx ON product_variants(product_remote_id);

CREATE TABLE orders (
  remote_id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  total_price TEXT,
  currency_code TEXT,
  financial_status TEXT,
  fulfillment_status TEXT,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  remote_updated_at TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX orders_shop_remote_idx ON orders(shop, remote_id);
CREATE INDEX orders_shop_updated_idx ON orders(shop, remote_updated_at);

CREATE TABLE sync_cursors (
  shop TEXT NOT NULL,
  resource TEXT NOT NULL,
  cursor TEXT,
  last_synced_at INTEGER,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  PRIMARY KEY (shop, resource)
);

CREATE TABLE sync_dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  resource TEXT NOT NULL,
  remote_id TEXT,
  payload TEXT,
  payload_hash TEXT,
  error TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX sync_dlq_shop_resource_idx ON sync_dead_letter(shop, resource);
CREATE INDEX sync_dlq_retry_idx ON sync_dead_letter(next_retry_at, resolved_at);
