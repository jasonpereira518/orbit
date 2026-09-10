/**
 * Finish populating `contact_identities` for contacts that predate it.
 *
 * The build (`scripts/migrate.ts`) runs a capped pass on every deploy, so this is only
 * needed to finish a large account in one go rather than waiting for successive deploys.
 *
 * Claims oldest-contact-first with ON CONFLICT DO NOTHING, then sweeps: every pre-existing
 * duplicate the app is confident about (a shared email, LinkedIn profile or X handle; a
 * shared name plus employer or role) is merged automatically. Each merge archives the losing
 * contact whole and can be undone from /contacts/duplicates, which is left holding only the
 * pairs that are genuinely ambiguous.
 *
 * Targets whatever DATABASE_URL says — the real database, like migrate.ts, not a smoke
 * fixture. Run: npx tsx scripts/backfill-contact-identities.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { backfillContactIdentities } from "../src/lib/contact-identity";
import { mergeConfidentDuplicates } from "../src/lib/duplicate-sweep";
import { closeDb } from "../src/db";

async function main() {
  const target = process.env.DATABASE_URL?.trim() ? "DATABASE_URL" : "local PGlite";
  console.log(`backfill: claiming contact identities on ${target}…`);

  let scanned = 0;
  let claimed = 0;
  const contested: string[] = [];
  const contestedUserIds: string[] = [];
  // Bounded passes rather than one unbounded query: each pass re-runs the anti-join, so a
  // contact processed by an earlier pass is not re-read.
  for (let pass = 1; ; pass++) {
    const result = await backfillContactIdentities({ limit: 2000 });
    scanned += result.scanned;
    claimed += result.claimed;
    contested.push(...result.contested);
    contestedUserIds.push(...result.contestedUserIds);
    console.log(`  pass ${pass}: ${result.scanned} scanned, ${result.claimed} claimed`);
    if (!result.more) break;
  }

  console.log(`\nbackfill: ${claimed} identities claimed across ${scanned} contacts.`);
  if (contested.length) {
    console.log(
      `${contested.length} contact(s) carry an identifier another contact already holds. ` +
        "Merging the ones that are unambiguous…"
    );
  }

  // Sweep every user the backfill touched. Without a userId the sweep is per-account, so
  // this script merges only for the account it was pointed at; the deploy hook in
  // scripts/migrate.ts does the same, one bounded pass at a time.
  const userIds = [...new Set(contestedUserIds)];
  let mergedTotal = 0;
  for (const userId of userIds) {
    const { merged, leftForReview } = await mergeConfidentDuplicates(userId);
    mergedTotal += merged;
    if (merged || leftForReview) {
      console.log(`  ${userId}: merged ${merged}, ${leftForReview} left for review`);
    }
  }
  console.log(
    mergedTotal
      ? `\nbackfill: merged ${mergedTotal} confident duplicate(s). Undo any of them at /contacts/duplicates.`
      : "\nbackfill: nothing needed merging."
  );

  await closeDb();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
