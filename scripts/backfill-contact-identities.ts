/**
 * Finish populating `contact_identities` for contacts that predate it.
 *
 * The build (`scripts/migrate.ts`) runs a capped pass on every deploy, so this is only
 * needed to finish a large account in one go rather than waiting for successive deploys.
 *
 * Claims oldest-contact-first with ON CONFLICT DO NOTHING. Contacts that lose a claim are
 * the account's pre-existing duplicates: they are reported and LEFT ALONE, never merged.
 * Merging them is a decision for /contacts/duplicates, where it can be reviewed and undone.
 *
 * Targets whatever DATABASE_URL says — the real database, like migrate.ts, not a smoke
 * fixture. Run: npx tsx scripts/backfill-contact-identities.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { backfillContactIdentities } from "../src/lib/contact-identity";
import { closeDb } from "../src/db";

async function main() {
  const target = process.env.DATABASE_URL?.trim() ? "DATABASE_URL" : "local PGlite";
  console.log(`backfill: claiming contact identities on ${target}…`);

  let scanned = 0;
  let claimed = 0;
  const contested: string[] = [];
  // Bounded passes rather than one unbounded query: each pass re-runs the anti-join, so a
  // contact processed by an earlier pass is not re-read.
  for (let pass = 1; ; pass++) {
    const result = await backfillContactIdentities({ limit: 2000 });
    scanned += result.scanned;
    claimed += result.claimed;
    contested.push(...result.contested);
    console.log(`  pass ${pass}: ${result.scanned} scanned, ${result.claimed} claimed`);
    if (!result.more) break;
  }

  console.log(
    `\nbackfill: ${claimed} identities claimed across ${scanned} contacts.` +
      (contested.length
        ? `\n${contested.length} contact(s) carry an identifier another contact already holds — ` +
          "these are pre-existing duplicates. Review them at /contacts/duplicates."
        : "\nNo pre-existing duplicates found.")
  );

  await closeDb();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
