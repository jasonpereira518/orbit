/** Shared by `efficiency-bench.ts` (seeding) and `efficiency-bench-ops.ts` (measuring). */
import { sql } from "drizzle-orm";
import { getDb } from "../../src/db";
import { generateApiKey } from "../../src/lib/api/keys";

/** Request-bound loaders resolve to this id on a local server with no Clerk keys. */
export const BENCH_USER = "demo-user";

export type BenchOp = { name: string; run: () => Promise<unknown> };

/** A read/write bearer for the MCP route. */
export async function benchApiKey(userId: string): Promise<string> {
  const db = await getDb();
  const key = generateApiKey("api");
  await db.execute(sql`
    INSERT INTO api_keys (user_id, name, kind, prefix, key_hash, scopes)
    VALUES (${userId}, 'bench', 'api', ${key.prefix}, ${key.keyHash}, '["read","write"]'::jsonb)
  `);
  return key.token;
}
