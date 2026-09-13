/**
 * Give every event that predates `event_aliases` the keys discovery recognises it by.
 *
 * Without this, the first discovery pass after deploy meets a table full of events it has
 * never "seen": a user with a Luma link already saved gets a second copy of the same event
 * the moment their calendar is read. `recordDiscoveryCandidates` has a fallback that matches
 * on the stored URL, which covers the window between deploying and running this — but the
 * fallback is a per-pass table scan and cannot see provider ids at all.
 *
 * Idempotent: every write is `ON CONFLICT DO NOTHING` on the unique index, and an event whose
 * keys already exist is skipped. Safe to run repeatedly, and safe to run while the app is up.
 *
 * Run: npx tsx scripts/backfill-event-aliases.ts [--dry]
 */
import "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { keysForEvent } from "../src/lib/events/discovery/record";

const BATCH = 500;

async function main() {
  const dry = process.argv.includes("--dry");
  const db = await getDb();

  const events = rowsOf<{
    id: string;
    user_id: string;
    url: string | null;
    provider: string | null;
    provider_event_id: string | null;
  }>(
    await db.execute(sql`
      SELECT e.id, e.user_id, e.url, e.provider, e.provider_event_id
        FROM events e
       WHERE NOT EXISTS (SELECT 1 FROM event_aliases a WHERE a.event_id = e.id)
       ORDER BY e.created_at
    `)
  );

  let written = 0;
  let skipped = 0;
  const values: ReturnType<typeof sql>[] = [];

  const flush = async () => {
    if (values.length === 0) return;
    if (!dry) {
      await db.execute(sql`
        INSERT INTO event_aliases (user_id, kind, value, event_id, source, evidence)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (user_id, kind, value) DO NOTHING
      `);
    }
    values.length = 0;
  };

  for (const event of events) {
    const keys = keysForEvent({
      url: event.url,
      provider: event.provider,
      providerEventId: event.provider_event_id,
    });
    // An event with no link and no provider id has nothing any source could recognise it by.
    // That is not a failure: a hand-typed "Coffee with the ACM board" is not discoverable, and
    // inventing a key for it would only risk colliding with a real one later.
    if (keys.length === 0) {
      skipped++;
      continue;
    }
    for (const key of keys) {
      values.push(
        sql`(${event.user_id}, ${key.kind}, ${key.value}, ${event.id}::uuid, 'backfill', '{}'::jsonb)`
      );
      written++;
    }
    if (values.length >= BATCH) await flush();
  }
  await flush();

  console.log(
    `${dry ? "[dry run] " : ""}events without aliases: ${events.length}; ` +
      `keys written: ${written}; events with nothing to key on: ${skipped}`
  );
  process.exit(0);
}

void main();
