// drizzle-kit config — drives `pnpm db:generate` (diffs schema → emits
// SQL migration) and `pnpm db:migrate` (applies migration to D1). The
// migrations directory ships with 0001_init_sync.sql; subsequent edits
// produce 0002, 0003, … which the deploy workflow runs in order.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./app/lib/db/schema.server.ts",
  out: "./migrations",
  dialect: "sqlite",
  driver: "d1-http",
});
