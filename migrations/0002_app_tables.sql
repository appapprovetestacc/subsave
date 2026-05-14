-- Phase 3.7 D — app-owned tables migration. Lives in 0002 because
-- 0001 is the Shopify-mirror tables. Drizzle Kit will keep generating
-- 0003+ as you evolve the schema.

CREATE TABLE app_settings (
  shop TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE custom_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX custom_records_lookup_idx ON custom_records(shop, namespace, key);
