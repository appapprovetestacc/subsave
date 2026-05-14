import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Phase 3.5 A — wizard-aware webhook coverage. Always tests the 3
// mandatory GDPR topics. Adds picks from the wizard's webhookTopics
// list + any sync-layer auto-registered webhooks.

const mandatoryTopics = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
];

test("mandatory GDPR webhooks are registered in appapprove.config.ts", () => {
  const config = readFileSync("appapprove.config.ts", "utf8");
  for (const topic of mandatoryTopics) {
    assert.equal(config.includes(topic), true, topic + " should be registered");
  }
});

test("each GDPR webhook has its handler module on disk", () => {
  const handlers = [
    "app/webhooks/customers-data-request.ts",
    "app/webhooks/customers-redact.ts",
    "app/webhooks/shop-redact.ts",
  ];
  for (const path of handlers) {
    const body = readFileSync(path, "utf8");
    assert.match(body, /WebhookHandler/);
  }
});

test("webhook router enforces HMAC verification", () => {
  const router = readFileSync("app/lib/webhook-router.server.ts", "utf8");
  assert.match(router, /verifyHmac/);
  assert.match(router, /HMAC/);
});

test("wizard-picked webhook topics are registered", () => {
  const config = readFileSync("appapprove.config.ts", "utf8");
  assert.equal(config.includes("orders/create"), true, "orders/create should be registered");
  assert.equal(config.includes("orders/cancelled"), true, "orders/cancelled should be registered");
  assert.equal(config.includes("customers/create"), true, "customers/create should be registered");
});
test("sync-layer per-resource webhooks are registered", () => {
  const config = readFileSync("appapprove.config.ts", "utf8");
  assert.match(config, /orders\//, "orders sync webhook should be registered");
  assert.match(config, /inventory_levels\/update/, "variants sync webhook (inventory_levels/update) should be registered");
  assert.match(config, /products\//, "products sync webhook should be registered");
});
