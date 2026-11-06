/**
 * Encrypt calendar subscription URLs saved before they were encrypted on write (Oct 13 2026).
 *
 * A Google "secret address" is read access to that calendar; `sealIcsUrl` now stores it like
 * the OAuth tokens. Rows from before still hold the plain URL, which `openIcsUrl` reads, so
 * nothing breaks while they wait — this just stops them sitting in the database as plaintext.
 *
 * Idempotent: an already-encrypted row is skipped. Prints ids only, never a URL. Every row is
 * read back through `openIcsUrl` before the write, so a wrong ENCRYPTION_SECRET fails here
 * rather than leaving rows the app cannot decrypt — run it with production's secret.
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (see `requireRealDatabase`).
 *
 * Run: npx tsx scripts/backfill-encrypt-ics-urls.ts [--dry]
 */
import { requireRealDatabase } from "./lib/operational-db";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { calendarSubscriptions } from "../src/db/schema";
import { openIcsUrl, sealIcsUrl } from "../src/lib/calendar-sync";

async function main() {
  const dry = process.argv.includes("--dry");
  requireRealDatabase("backfill-encrypt-ics-urls");
  const db = await getDb();

  const rows = await db
    .select({ id: calendarSubscriptions.id, icsUrl: calendarSubscriptions.icsUrl })
    .from(calendarSubscriptions)
    .where(sql`${calendarSubscriptions.icsUrl} ~* '^(https?|webcal)://'`);

  let changed = 0;
  for (const row of rows) {
    const sealed = sealIcsUrl(row.icsUrl);
    if (openIcsUrl(sealed) !== row.icsUrl) throw new Error(`Round trip failed for ${row.id} — nothing written for it`);
    changed++;
    console.log(`${dry ? "would encrypt" : "encrypted"} ${row.id}`);
    if (!dry) await db.update(calendarSubscriptions).set({ icsUrl: sealed }).where(eq(calendarSubscriptions.id, row.id));
  }
  console.log(`\n${changed} plaintext subscription URL(s) ${dry ? "would be encrypted" : "encrypted"}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
