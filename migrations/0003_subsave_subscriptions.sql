-- SubSave — recurring subscription tables. Extends the app-owned tables
-- migration in 0002 with the entities that drive the renewal cron:
-- subscriptions, subscription_charges, and the dunning queue.

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  customer_remote_id TEXT NOT NULL,
  customer_email TEXT,
  product_remote_id TEXT NOT NULL,
  variant_remote_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  cadence_days INTEGER NOT NULL DEFAULT 30,
  price_cents INTEGER NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'active',
  next_renewal_at INTEGER NOT NULL,
  last_charge_at INTEGER,
  skip_next_renewal INTEGER NOT NULL DEFAULT 0,
  pre_renewal_email_sent_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_shop_idx ON subscriptions(shop);
CREATE INDEX subscriptions_shop_status_idx ON subscriptions(shop, status);
CREATE INDEX subscriptions_renewal_idx ON subscriptions(status, next_renewal_at);
CREATE INDEX subscriptions_customer_idx ON subscriptions(shop, customer_remote_id);

CREATE TABLE subscription_charges (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  currency_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  shopify_draft_order_id TEXT,
  shopify_order_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  attempted_at INTEGER NOT NULL,
  succeeded_at INTEGER
);
CREATE INDEX charges_subscription_idx ON subscription_charges(subscription_id, attempted_at);
CREATE INDEX charges_shop_status_idx ON subscription_charges(shop, status);

CREATE TABLE dunning_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  charge_id TEXT NOT NULL REFERENCES subscription_charges(id) ON DELETE CASCADE,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT,
  resolved_at INTEGER,
  resolution TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX dunning_retry_idx ON dunning_attempts(next_retry_at, resolved_at);
CREATE INDEX dunning_subscription_idx ON dunning_attempts(subscription_id);
CREATE UNIQUE INDEX dunning_charge_unique_idx ON dunning_attempts(charge_id);
