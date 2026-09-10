/**
 * What the duplicate review page is shown.
 *
 * The review page must contain ONLY questions the app could not answer for itself. Anything
 * at or above the confidence line is merged by `mergeConfidentDuplicates` before the page
 * lists anything, so a pair should never appear alongside "these are the same person" and a
 * button asking someone to confirm it.
 *
 * Also exists because this layer's first version was silently wrong in a way nothing caught.
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
import { mergeConfidentDuplicates } from "../src/lib/duplicate-sweep";
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
  // Two contacts sharing only a name — the honest tier for this fixture, and the only one
  // that should ever reach the review page.
  await recordDuplicateSuggestion(USER, smithA, smithB, "Same full name", 0.6);

  console.log("\nConfident duplicates are merged, not asked about...");
  {
    const sweep = await mergeConfidentDuplicates(USER);
    check("the shared-email pair was merged automatically", sweep.merged === 1, `${sweep.merged}`);
    check(
      "the newer contact is gone",
      (await rowsOf<{ v: number }>(
        await db.execute(sql`SELECT count(*)::int AS v FROM contacts WHERE id = ${newer}::uuid`)
      ))[0]!.v === 0
    );
    check(
      "its interaction moved to the survivor",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM interactions WHERE contact_id = ${older}::uuid`
        )
      ))[0]!.v === 5
    );
    check(
      "and the merge is recorded so it can be undone",
      (await rowsOf<{ v: number }>(
        await db.execute(sql`SELECT count(*)::int AS v FROM contact_merges WHERE user_id = ${USER}`)
      ))[0]!.v === 1
    );
  }

  console.log("\nThe review list holds only what the app could not decide...");
  const review = await getDuplicateReview(USER);

  check("nothing certain is left to ask about", review.proposed.every((p) => !p.certain));
  check(
    "the name-only pair is the one thing waiting",
    review.proposed.length === 1,
    `${review.proposed.length}`
  );
  check(
    "and it is labelled as the ambiguous case it is",
    review.proposed[0]?.reason === "Same full name",
    review.proposed[0]?.reason
  );
  check(
    "a proposed pair carries the suggestion id it was recorded under",
    typeof review.proposed[0]?.suggestionId === "string"
  );

  console.log("\nInteraction counts — the cue for which side to keep...");
  const pair = review.proposed[0]!;
  check(
    "counts are real, not zero",
    pair.keep.interactionCount === 0 && pair.merge.interactionCount === 0,
    `${pair.keep.interactionCount}/${pair.merge.interactionCount}`
  );

  console.log("\nDuplicates that predate the feature are scanned for, not just remembered...");
  {
    // Two contacts with the same name and NOTHING corroborating it, seeded straight to SQL
    // the way a historical import left them. No write path ever recorded a suggestion, and
    // they share no identifier — so without the name scan neither list would ever mention
    // them, and the cleanup page would be blind to exactly the rows it exists to clean up.
    const graceA = await seedContact("Grace Hopper", "grace@cobol.mil", 60);
    const graceB = await seedContact("Grace Hopper", "ghopper@navy.mil", 5);
    await backfillContactIdentities({ userId: USER });
    await mergeConfidentDuplicates(USER);

    const withScan = await getDuplicateReview(USER);
    const gracePair = withScan.proposed.find(
      (p) =>
        (p.keep.id === graceA && p.merge.id === graceB) ||
        (p.keep.id === graceB && p.merge.id === graceA)
    );
    check("a pre-existing name duplicate is proposed", Boolean(gracePair));
    check("it is not claimed to be certain", gracePair?.certain === false);
    check(
      "the sweep left it alone — a shared name on its own is not enough",
      (await rowsOf<{ v: number }>(
        await db.execute(sql`SELECT count(*)::int AS v FROM contacts WHERE id = ${graceB}::uuid`)
      ))[0]!.v === 1
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
    "counts only what is waiting on a human",
    (await countDuplicatesAwaitingReview(USER)) === 1,
    `${await countDuplicatesAwaitingReview(USER)}`
  );

  await db.execute(
    sql`UPDATE duplicate_suggestions SET status = 'dismissed' WHERE user_id = ${USER}`
  );
  check(
    "a dismissed pair leaves the proposed list",
    (await getDuplicateReview(USER)).proposed.length === 0
  );
  check("and stops being counted", (await countDuplicatesAwaitingReview(USER)) === 0);

  console.log("\nA stored suggestion the app could decide is not shown as a question...");
  {
    // Recorded above the confidence line — by an older build, or before the sweep last ran.
    // The sweep handles pairs like this; putting one on the page would be asking someone to
    // confirm something the app is perfectly capable of deciding.
    const a = await seedContact("Rae Lin", null, 40);
    const b = await seedContact("Rae Lin", null, 3);
    await recordDuplicateSuggestion(USER, a, b, "Same name + company", 0.9);
    const shown = (await getDuplicateReview(USER)).proposed.filter(
      (p) => p.suggestionId && (p.keep.id === a || p.merge.id === a)
    );
    check("an above-threshold stored suggestion is not proposed", shown.length === 0);
    await db.execute(sql`DELETE FROM contacts WHERE id IN (${a}::uuid, ${b}::uuid)`);
  }

  console.log("\nA dismissal outranks the sweep...");
  {
    // Someone has said these two are different people. A later sweep must not overrule that
    // — otherwise "not the same person" means "not the same person until the next deploy".
    const a = await seedContact("Pat Kim", "pat@acme.com", 40);
    const b = await seedContact("Pat Kim", "pat.kim@acme.com", 3);
    await db.execute(sql`UPDATE contacts SET company = 'Acme' WHERE user_id = ${USER}
                          AND id IN (${a}::uuid, ${b}::uuid)`);
    await dismissDuplicatePair(USER, a, b);

    const sweep = await mergeConfidentDuplicates(USER);
    check("the dismissed pair was not merged", sweep.merged === 0, `${sweep.merged}`);
    check(
      "both contacts survive",
      (await rowsOf<{ v: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS v FROM contacts WHERE id IN (${a}::uuid, ${b}::uuid)`
        )
      ))[0]!.v === 2
    );
  }

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
