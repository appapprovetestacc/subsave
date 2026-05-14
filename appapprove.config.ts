// AppApprove project configuration. Edit webhook routes, build hooks, and
// environment variable mappings here. The pricing schema lives separately
// in pricing.yaml.
//
// Full reference: https://appapprove.com/docs/config

import type { AppApproveConfig } from "./app/lib/appapprove-config";

const config: AppApproveConfig = {
  slug: "subsave",
  framework: "remix-cloudflare-workers",
  webhooks: {
    // Map Shopify topics to handler modules. AppApprove's webhook router
    // verifies HMAC and dispatches the parsed payload to your handler.
    "customers/data_request": "~/webhooks/customers-data-request",
    "customers/redact": "~/webhooks/customers-redact",
    "shop/redact": "~/webhooks/shop-redact",
    "app_subscriptions/update": "~/webhooks/app-subscriptions-update",
    // Phase 3.7 B — managed sync webhooks
    "products/create": "~/webhooks/products-upsert",
    "products/update": "~/webhooks/products-upsert",
    "products/delete": "~/webhooks/products-delete",
    "inventory_levels/update": "~/webhooks/variants-inventory",
    "orders/create": "~/webhooks/orders-upsert",
    "orders/updated": "~/webhooks/orders-upsert",
    "orders/cancelled": "~/webhooks/orders-upsert",
    "orders/delete": "~/webhooks/orders-delete",
  },
  crons: {
    // CF Cron Trigger schedules. The example handler runs hourly.
    // To enable, also add the same schedule to wrangler.toml `[triggers]`.
    // "0 * * * *": "~/crons/example-cleanup",

    // Daily GDPR deadline scan — warns 7 days before any open
    // customers/data_request, customers/redact, or shop/redact request
    // would breach the 30-day SLA. Wire up by ALSO adding "0 8 * * *" to
    // wrangler.toml [triggers] crons.
    "0 8 * * *": "~/crons/gdpr-deadline-check",

    // Phase 3.7 B — sync backfill driver. Runs every 5 minutes
    // and processes one page per resource per shop. Mirror the schedule
    // in wrangler.toml [triggers] crons.
    "*/5 * * * *": "~/crons/sync-backfill",
  },
  env: {
    // Public env vars are exposed to the browser. Secrets stay server-only.
    public: [],
    secrets: ["SHOPIFY_API_SECRET", "SYNC_STATUS_TOKEN"],
  },
  pricing: "./pricing.yaml",
};

export default config;
