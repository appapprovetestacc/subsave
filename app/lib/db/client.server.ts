// D1 client + Drizzle wrapper. Generated apps get the D1 binding from
// the CF Workers env (configured in wrangler.toml [[d1_databases]]). The
// AppApprove deploy pipeline provisions the database on first deploy and
// pushes the binding name into `load-context.ts` Env.

import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema.server";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function getDb(d1: D1Database): Db {
  return drizzle(d1, { schema, logger: false });
}

export { schema };
