# Merchant onboarding for SubSave

## Setup

1. Install the app from the approved install link.
2. Open the app from Shopify admin so the embedded App Bridge session is established.
3. Complete the admin dashboard setup and save settings before testing storefront or webhook behavior.
4. Choose the recurring subscription test plan in /billing before using paid features.
5. Visit /support, /privacy, /data-retention, /status, /health, and /version before submitting to Shopify.

## Capabilities and scopes

- `read_products`
- `read_orders`
- `write_orders`
- `read_customers`
- `write_customers`
- `write_products`

## Feature quick starts

- Review the embedded admin dashboard, update settings, and verify saved values persist after reload.
- Trigger each webhook topic listed below and confirm HMAC verification plus handler success in logs.
- Run or wait for the scheduled cron and confirm it reports success without duplicate side effects.
- Send a transactional test email to a reviewer-controlled address and verify sender identity.

## Vertical tips

- This scaffold started from the Subscriptions preset: Recurring orders, dunning, plan changes — Stripe-style for Shopify.
- Test plan creation, pause/skip/cancel, renewal retry, and dunning email behavior.
