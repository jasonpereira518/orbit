/**
 * Copy legacy `interactions.action_items` (a jsonb string array) into `action_items` rows.
 *
 * This used to be a statement in SCALE_DDL, so it re-read every user's interactions on every
 * SCHEMA_VERSION bump, long after every live database had been backfilled. Every write path
 * now syncs rows itself (`syncActionItems`), so the only database this can matter for is a
 * very old local one. Idempotent: the unique (user_id, item_hash) index absorbs re-runs.
 * The hash formula MUST equal actionItemHash() in src/lib/action-items.ts
 * (`scripts/smoke-action-items.ts` pins that parity).
 *
 * Targets whatever DATABASE_URL says, like migrate.ts. Run: npx tsx scripts/backfill-action-items.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";

async function main() {
  const target = process.env.DATABASE_URL?.trim() ? "DATABASE_URL" : "local PGlite";
  console.log(`backfill: copying legacy action items on ${target}…`);
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO action_items (user_id, contact_id, interaction_id, text, position, item_hash)
    SELECT i.user_id, i.contact_id, i.id, a.value, a.ordinality - 1,
           encode(sha256(convert_to(i.id::text || '|' || lower(btrim(a.value)), 'UTF8')), 'hex')
    FROM interactions i, jsonb_array_elements_text(COALESCE(i.action_items, '[]'::jsonb)) WITH ORDINALITY a
    WHERE jsonb_typeof(i.action_items) = 'array' AND btrim(a.value) <> ''
    ON CONFLICT (user_id, item_hash) DO NOTHING
  `);
  console.log("backfill: done");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
