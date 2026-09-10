/**
 * What the duplicate review page is shown.
 *
 * Exists because this layer's first version was silently wrong in a way nothing caught.
 * `interactionCount` was a correlated subquery written as
 *
 *   sql`(SELECT count(*)::int FROM interactions i WHERE i.contact_id = ${contacts.id})`
 *
 * inside a drizzle `.select()` projection. Drizzle renders an interpolated column there
 * UNQUALIFIED, so it compiled to `i.contact_id = "id"` — binding to `interactions.id`, never
 * true, zero for every contact. Postgres accepted it, tsc accepted it, eslint accepted it,
 * and the page rendered "0 interactions" under every name. That number is the one cue for
 * which side of a pair to keep, so being quietly wrong made the page actively misleading.
 *
 * Writes to local PGlite. Stop this worktree's dev server first — two writers corrupt it.
 * Run: npx tsx scripts/smoke-duplicate-review.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf, closeDb } from "../src/db";
import { backfillContactIdentities } from "../src/lib/contact-identity";
import { dismissDuplicatePair, recordDuplicateSuggestion } from "../src/lib/contact-merge";
import {
  countDuplicatesAwaitingReview,
  getDuplicateReview,
} from "../src/lib/duplicate-review";

const USER = "duplicate-review-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM contact_merges WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM duplicate_suggestions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
}

async function seedContact(
  fullName: string,
  email: string | null,
  daysAgo: number
): Promise<string> {
  const db = await getDb();
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name, email, created_at)
      VALUES (${USER}, ${fullName}, ${email}, now() - ${`${daysAgo} days`}::interval)
      RETURNING id
    `)
  )[0]!.id;
}

async function main() {
  await reset();
  const db = await getDb();

  const older = await seedContact("Ada Lovelace", "ada@analytical.io", 30);
  const newer = await seedContact("Ada Lovelace", "ada@analytical.io", 2);
  const smithA = await seedContact("John Smith", "js@acme.com", 90);
  const smithB = await seedContact("John Smith", null, 1);

  // Four on the older contact, one on the newer: an asymmetry the page must report
  // correctly, because it is the whole basis for choosing which record survives.
  for (let i = 0; i < 4; i++) {
    await db.execute(sql`
      INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes)
      VALUES (${USER}, ${older}::uuid, 'note', ${`note ${i}`})
    `);
  }
  await db.execute(sql`
    INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes)
    VALUES (${USER}, ${newer}::uuid, 'note', 'one note')
  `);

  await backfillContactIdentities({ userId: USER });
  await recordDuplicateSuggestion(USER, smithA, smithB, "Same name + company", 0.9);

  console.log("\nThe review page's two lists...");
  const review = await getDuplicateReview(USER);

  check("the shared email is reported as certain", review.certain.length === 1, `${review.certain.length}`);
  check("the name-only pair is reported as proposed", review.proposed.length === 1, `${review.proposed.length}`);
  check(
    "a certain pair is labelled by its identifier",
    review.certain[0]?.reason === "Same email",
    review.certain[0]?.reason
  );
  check("a certain pair is marked certain", review.certain[0]?.certain === true);
  check("a proposed pair is not", review.proposed[0]?.certain === false);
  check(
    "a proposed pair carries the suggestion id it is dismissed by",
    typeof review.proposed[0]?.suggestionId === "string"
  );

  console.log("\nInteraction counts — the cue for which side to keep...");
  const pair = review.certain[0]!;
  check(
    "the older contact is proposed as the survivor",
    pair.keep.id === older,
    `${pair.keep.id === older ? "older" : "newer"}`
  );
  check(
    "the survivor's interaction count is real, not zero",
    pair.keep.interactionCount === 4,
    `${pair.keep.interactionCount}`
  );
  check(
    "the other side's count is real too",
    pair.merge.interactionCount === 1,
    `${pair.merge.interactionCount}`
  );
  check(
    "a contact with no interactions counts zero rather than being dropped",
    review.proposed[0]!.merge.interactionCount === 0 ||
      review.proposed[0]!.keep.interactionCount === 0
  );

  console.log("\nDuplicates that predate the feature are scanned for, not just remembered...");
  {
    // Two contacts with the same name and company but DIFFERENT emails, seeded straight to
    // SQL the way a historical import left them. No write path ever recorded a suggestion
    // for them, and they share no identifier — so without the name scan neither list would
    // ever mention them, and the cleanup page would be blind to exactly the rows it exists
    // to clean up.
    const graceA = await seedContact("Grace Hopper", "grace@cobol.mil", 60);
    const graceB = await seedContact("Grace Hopper", "ghopper@navy.mil", 5);
    await backfillContactIdentities({ userId: USER });

    const withScan = await getDuplicateReview(USER);
    const gracePair = withScan.proposed.find(
      (p) =>
        (p.keep.id === graceA && p.merge.id === graceB) ||
        (p.keep.id === graceB && p.merge.id === graceA)
    );
    check("a pre-existing name duplicate is proposed", Boolean(gracePair));
    check("it is not claimed to be certain", gracePair?.certain === false);
    check(
      "distinct emails did not make it an identifier collision",
      !withScan.certain.some((p) => p.keep.id === graceA || p.merge.id === graceA)
    );

    // A scanned pair has no stored row, so dismissing it has to create one — otherwise it
    // is proposed again on every single visit and the list can never be cleared.
    await dismissDuplicatePair(USER, graceA, graceB);
    const afterDismiss = await getDuplicateReview(USER);
    check(
      "dismissing a scanned pair sticks",
      !afterDismiss.proposed.some(
        (p) =>
          (p.keep.id === graceA && p.merge.id === graceB) ||
          (p.keep.id === graceB && p.merge.id === graceA)
      )
    );
  }

  console.log("\nThe entry-point count...");
  check(
    "counts every list",
    (await countDuplicatesAwaitingReview(USER)) === 2,
    `${await countDuplicatesAwaitingReview(USER)}`
  );

  await db.execute(
    sql`UPDATE duplicate_suggestions SET status = 'dismissed' WHERE user_id = ${USER}`
  );
  check(
    "a dismissed pair leaves the proposed list",
    (await getDuplicateReview(USER)).proposed.length === 0
  );
  check("and stops being counted", (await countDuplicatesAwaitingReview(USER)) === 1);

  await reset();
  await closeDb();

  console.log(
    failures === 0
      ? "\nAll duplicate-review checks passed."
      : `\n${failures} duplicate-review check(s) FAILED.`
  );
  if (failures) process.exit(1);
}

run(main);
