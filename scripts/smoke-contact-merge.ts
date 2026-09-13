/**
 * Merge and unmerge, end to end.
 *
 * The properties here are the ones whose absence is silent and permanent:
 *
 *  - After a merge, NOTHING anywhere still points at the loser. The loser's `contacts` row
 *    is deleted rather than flagged precisely so that ~100 unfiltered read sites cannot
 *    leak it; a child row left behind is a foreign key to a uuid that no longer exists.
 *  - The fold fills the winner's blanks and never clobbers a value it already had.
 *  - Collision-prone children (a tag both contacts carry, a mention of both on one
 *    interaction) resolve without raising a unique violation and without losing the row.
 *  - Unmerge restores the contact byte-for-byte, including columns not declared in
 *    schema.ts and the GENERATED ALWAYS columns Postgres recomputes.
 *  - A chain A -> B -> C stays walkable, and unmerging out of order is refused rather
 *    than corrupting both merges.
 *
 * Writes to local PGlite. Stop this worktree's dev server first — two writers corrupt it.
 * Run: npx tsx scripts/smoke-contact-merge.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf, closeDb } from "../src/db";
import {
  mergeContacts,
  unmergeContacts,
  resolveContactId,
  recordDuplicateSuggestion,
} from "../src/lib/contact-merge";

const USER = "contact-merge-smoke-user";
const OTHER = "contact-merge-smoke-other";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.execute(sql`DELETE FROM contact_merges WHERE user_id = ${user}`);
    await db.execute(sql`DELETE FROM duplicate_suggestions WHERE user_id = ${user}`);
    await db.execute(sql`DELETE FROM interactions WHERE user_id = ${user}`);
    await db.execute(sql`DELETE FROM contacts WHERE user_id = ${user}`);
    await db.execute(sql`DELETE FROM tags WHERE user_id = ${user}`);
    await db.execute(sql`DELETE FROM companies WHERE user_id = ${user}`);
  }
}

async function newContact(fields: Record<string, unknown>, user = USER): Promise<string> {
  const db = await getDb();
  const cols = Object.keys(fields);
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO contacts (user_id, ${sql.join(cols.map((c) => sql.raw(`"${c}"`)), sql`, `)})
      VALUES (${user}, ${sql.join(cols.map((c) => sql`${fields[c] as never}`), sql`, `)})
      RETURNING id
    `)
  );
  return rows[0]!.id;
}

async function scalar<T>(query: ReturnType<typeof sql>): Promise<T> {
  const db = await getDb();
  return rowsOf<{ v: T }>(await db.execute(query))[0]!.v;
}

/** Every table that carries a contact id, asked directly: does anything still name this id? */
async function danglingReferences(contactId: string): Promise<string[]> {
  const db = await getDb();
  const tables: [string, string][] = [
    ["interactions", "contact_id"],
    ["reminders", "contact_id"],
    ["suggested_reminders", "contact_id"],
    ["action_items", "contact_id"],
    ["contact_experiences", "contact_id"],
    ["outreach_prospects", "contact_id"],
    ["user_recruiter_links", "contact_id"],
    ["event_attendees", "contact_id"],
    ["contact_identities", "contact_id"],
    ["note_batches", "seed_contact_id"],
    ["import_job_rows", "contact_id"],
    ["contact_tags", "contact_id"],
    ["interaction_mentions", "contact_id"],
    ["contact_profiles", "contact_id"],
    ["contact_embeddings", "contact_id"],
    ["contact_briefs", "contact_id"],
  ];
  const found: string[] = [];
  for (const [table, column] of tables) {
    const n = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${sql.raw(column)} = ${contactId}::uuid`
      )
    )[0]!.n;
    if (n > 0) found.push(`${table}.${column}=${n}`);
  }
  return found;
}

async function main() {
  await reset();
  const db = await getDb();

  // ---------------------------------------------------------------------------------
  console.log("\nA merge moves every child row and leaves nothing behind...");
  {
    const winner = await newContact({
      full_name: "Ada Lovelace",
      email: "ada@analytical.io",
      company: "Analytical Engines",
      // Deliberately blank so the fold has somewhere to put the loser's value.
      title: null,
      notes: "Met at the symposium.",
      last_interaction_at: new Date("2026-01-01").toISOString(),
    });
    const loser = await newContact({
      full_name: "Ada Lovelace",
      email: "ada@other.io",
      title: "Mathematician",
      phone: "+14155550100",
      notes: "Follow up about the engine.",
      first_interaction_at: new Date("2020-01-01").toISOString(),
      last_interaction_at: new Date("2026-06-01").toISOString(),
    });

    // One interaction on each side, plus a tag both carry and a tag only the loser has.
    await db.execute(
      sql`INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes)
          VALUES (${USER}, ${winner}::uuid, 'note', 'winner note'),
                 (${USER}, ${loser}::uuid, 'note', 'loser note')`
    );
    const shared = rowsOf<{ id: string }>(
      await db.execute(
        sql`INSERT INTO tags (user_id, name) VALUES (${USER}, 'shared') RETURNING id`
      )
    )[0]!.id;
    const loserOnly = rowsOf<{ id: string }>(
      await db.execute(
        sql`INSERT INTO tags (user_id, name) VALUES (${USER}, 'loser-only') RETURNING id`
      )
    )[0]!.id;
    await db.execute(
      sql`INSERT INTO contact_tags (contact_id, tag_id)
          VALUES (${winner}::uuid, ${shared}::uuid),
                 (${loser}::uuid, ${shared}::uuid),
                 (${loser}::uuid, ${loserOnly}::uuid)`
    );

    const { mergeId } = await mergeContacts(USER, winner, loser, {
      reason: "Same email",
      confidence: 0.95,
    });

    check(
      "the loser's contact row is gone",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM contacts WHERE id = ${loser}::uuid`
      )) === 0
    );
    const dangling = await danglingReferences(loser);
    check("nothing anywhere still points at the loser", dangling.length === 0, dangling.join(", "));
    check(
      "both interactions belong to the winner",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM interactions WHERE contact_id = ${winner}::uuid`
      )) === 2
    );
    check(
      "the shared tag did not raise a unique violation and was not duplicated",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM contact_tags
             WHERE contact_id = ${winner}::uuid AND tag_id = ${shared}::uuid`
      )) === 1
    );
    check(
      "the loser-only tag moved across",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM contact_tags
             WHERE contact_id = ${winner}::uuid AND tag_id = ${loserOnly}::uuid`
      )) === 1
    );

    const merged = rowsOf<{
      title: string | null;
      email: string;
      phone: string | null;
      notes: string;
      first_interaction_at: string | null;
      last_interaction_at: string | null;
    }>(
      await db.execute(
        sql`SELECT title, email, phone, notes, first_interaction_at, last_interaction_at
              FROM contacts WHERE id = ${winner}::uuid`
      )
    )[0]!;
    check("a blank on the winner is filled from the loser", merged.title === "Mathematician");
    check("a value the winner already had is NOT clobbered", merged.email === "ada@analytical.io");
    check("a column only the loser had comes across", merged.phone === "+14155550100");
    check(
      "notes are appended, never replaced",
      merged.notes.includes("Met at the symposium.") &&
        merged.notes.includes("Follow up about the engine.")
    );
    check(
      "the interaction window widens on the early side",
      merged.first_interaction_at !== null &&
        new Date(merged.first_interaction_at).getUTCFullYear() === 2020
    );
    check(
      "the interaction window widens on the late side",
      merged.last_interaction_at !== null &&
        new Date(merged.last_interaction_at).getUTCMonth() === 5
    );

    // -------------------------------------------------------------------------------
    console.log("\n...and unmerging puts it all back.");
    const before = rowsOf<{ row: Record<string, unknown> }>(
      await db.execute(
        sql`SELECT loser_snapshot AS row FROM contact_merges WHERE id = ${mergeId}::uuid`
      )
    )[0]!.row;

    await unmergeContacts(USER, mergeId);

    const after = rowsOf<{ row: Record<string, unknown> }>(
      await db.execute(sql`SELECT to_jsonb(c) AS row FROM contacts c WHERE c.id = ${loser}::uuid`)
    );
    check("the contact is back, with its original id", after.length === 1);
    if (after.length === 1) {
      // Two columns are legitimately not restored verbatim. `updated_at` moves because the
      // row was just written, and `embedding_stale_at` is deliberately set by the rebuild
      // the unmerge schedules — a restored contact's stored vector describes the merged
      // state and has to be recomputed. Everything else, including columns not declared in
      // schema.ts, must come back exactly.
      const ignore = new Set(["updated_at", "embedding_stale_at"]);
      const diffs = Object.keys(before).filter(
        (k) => !ignore.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[0]!.row[k])
      );
      check("every column is restored byte-for-byte", diffs.length === 0, diffs.join(", "));
      check(
        "the generated sort key was recomputed, not inserted",
        typeof after[0]!.row.sort_key === "string" && after[0]!.row.sort_key !== ""
      );
    }
    check(
      "the loser's interaction went back with it",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM interactions
             WHERE contact_id = ${loser}::uuid AND raw_notes = 'loser note'`
      )) === 1
    );
    check(
      "the winner keeps its own interaction",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM interactions
             WHERE contact_id = ${winner}::uuid AND raw_notes = 'winner note'`
      )) === 1
    );
    check(
      "the tag that had to be deleted rather than moved is restored",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM contact_tags WHERE contact_id = ${loser}::uuid`
      )) === 2
    );
    check(
      "the archive row is gone once undone",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM contact_merges WHERE id = ${mergeId}::uuid`
      )) === 0
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nInteraction mentions collide on (interaction_id, contact_id)...");
  await reset();
  {
    const winner = await newContact({ full_name: "Grace Hopper" });
    const loser = await newContact({ full_name: "Grace Hopper" });
    const interactionId = rowsOf<{ id: string }>(
      await db.execute(
        sql`INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes)
            VALUES (${USER}, ${winner}::uuid, 'note', 'both mentioned') RETURNING id`
      )
    )[0]!.id;
    // Both contacts mentioned on the SAME interaction: repointing the loser's row would
    // collide with the winner's.
    await db.execute(
      sql`INSERT INTO interaction_mentions
            (user_id, interaction_id, contact_id, mention_text, confidence, matched_by)
          VALUES (${USER}, ${interactionId}::uuid, ${winner}::uuid, 'Grace', 0.9, 'name'),
                 (${USER}, ${interactionId}::uuid, ${loser}::uuid, 'Grace', 0.9, 'name')`
    );

    const { mergeId } = await mergeContacts(USER, winner, loser);
    check(
      "the colliding mention was dropped, not duplicated",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM interaction_mentions
             WHERE interaction_id = ${interactionId}::uuid`
      )) === 1
    );
    check("no mention still names the loser", (await danglingReferences(loser)).length === 0);

    await unmergeContacts(USER, mergeId);
    check(
      "the dropped mention comes back on unmerge",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM interaction_mentions
             WHERE interaction_id = ${interactionId}::uuid`
      )) === 2
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nMerges chain, and the alias stays walkable...");
  await reset();
  {
    const a = await newContact({ full_name: "Alan Turing", email: "a@x.io" });
    const b = await newContact({ full_name: "Alan Turing", email: "b@x.io" });
    const c = await newContact({ full_name: "Alan Turing", email: "c@x.io" });

    // a merges into b, then b merges into c.
    const first = await mergeContacts(USER, b, a);
    const second = await mergeContacts(USER, c, b);

    check("the oldest id resolves all the way to the survivor", (await resolveContactId(USER, a)) === c);
    check("the middle id resolves to the survivor", (await resolveContactId(USER, b)) === c);
    check("a live id resolves to itself", (await resolveContactId(USER, c)) === c);
    check(
      "path compression rewrote the first archive row",
      (await scalar<string>(
        sql`SELECT winner_contact_id::text AS v FROM contact_merges WHERE id = ${first.mergeId}::uuid`
      )) === c
    );

    // Undone newest-first: the ordinary case.
    await unmergeContacts(USER, second.mergeId);
    check(
      "undoing the later merge brings the middle contact back",
      (await scalar<number>(sql`SELECT count(*)::int AS v FROM contacts WHERE id = ${b}::uuid`)) === 1
    );
    check(
      "path compression is undone, so the first archive points at the middle again",
      (await scalar<string>(
        sql`SELECT winner_contact_id::text AS v FROM contact_merges WHERE id = ${first.mergeId}::uuid`
      )) === b
    );
    check("the oldest id now resolves to the middle contact", (await resolveContactId(USER, a)) === b);

    await unmergeContacts(USER, first.mergeId);
    check(
      "undoing the rest restores all three contacts",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM contacts WHERE user_id = ${USER}`
      )) === 3
    );
    check("and no archive rows remain", (await scalar<number>(
      sql`SELECT count(*)::int AS v FROM contact_merges WHERE user_id = ${USER}`
    )) === 0);
  }

  // ---------------------------------------------------------------------------------
  console.log("\nA chain may also be undone out of order...");
  await reset();
  {
    const a = await newContact({ full_name: "Out Of Order A", email: "ooa@x.io" });
    const b = await newContact({ full_name: "Out Of Order B", email: "oob@x.io" });
    const c = await newContact({ full_name: "Out Of Order C", email: "ooc@x.io" });
    await db.execute(
      sql`INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes)
          VALUES (${USER}, ${a}::uuid, 'note', 'belongs to a')`
    );

    const first = await mergeContacts(USER, b, a);
    await mergeContacts(USER, c, b);

    // Path compression means `first` now names c, the contact that actually holds a's rows,
    // so undoing it works without touching the later merge.
    await unmergeContacts(USER, first.mergeId);
    check(
      "the earlier merge can be undone first",
      (await scalar<number>(sql`SELECT count(*)::int AS v FROM contacts WHERE id = ${a}::uuid`)) === 1
    );
    check(
      "and its interaction comes back out of the eventual survivor",
      (await scalar<string>(
        sql`SELECT contact_id::text AS v FROM interactions WHERE raw_notes = 'belongs to a'`
      )) === a
    );
    check("the middle contact is still merged away", (await resolveContactId(USER, b)) === c);
  }

  // ---------------------------------------------------------------------------------
  console.log("\nGuards...");
  await reset();
  {
    const mine = await newContact({ full_name: "Mine" });
    const theirs = await newContact({ full_name: "Theirs" }, OTHER);

    let sameContact = false;
    try {
      await mergeContacts(USER, mine, mine);
    } catch {
      sameContact = true;
    }
    check("merging a contact into itself is refused", sameContact);

    let crossTenant = false;
    try {
      await mergeContacts(USER, mine, theirs);
    } catch {
      crossTenant = true;
    }
    check("merging another user's contact is refused", crossTenant);
    check(
      "and that contact is untouched",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM contacts WHERE id = ${theirs}::uuid`
      )) === 1
    );
  }

  // ---------------------------------------------------------------------------------
  console.log("\nName-tier suggestions...");
  await reset();
  {
    const a = await newContact({ full_name: "Jean Bartik", company: "ENIAC" });
    const b = await newContact({ full_name: "Jean Bartik", company: "ENIAC" });

    await recordDuplicateSuggestion(USER, a, b, "Same name + company", 0.9);
    // Same pair, opposite order — must not create a second row.
    await recordDuplicateSuggestion(USER, b, a, "Same name + company", 0.9);
    check(
      "a pair is one row regardless of the order it is offered in",
      (await scalar<number>(
        sql`SELECT count(*)::int AS v FROM duplicate_suggestions WHERE user_id = ${USER}`
      )) === 1
    );

    await db.execute(
      sql`UPDATE duplicate_suggestions SET status = 'dismissed' WHERE user_id = ${USER}`
    );
    await recordDuplicateSuggestion(USER, a, b, "Same name + company", 0.9);
    check(
      "a dismissed pair is not re-proposed",
      (await scalar<string>(
        sql`SELECT status AS v FROM duplicate_suggestions WHERE user_id = ${USER}`
      )) === "dismissed"
    );
  }

  await reset();
  await closeDb();

  console.log(
    failures === 0
      ? "\nAll contact-merge checks passed."
      : `\n${failures} contact-merge check(s) FAILED.`
  );
  if (failures) process.exit(1);
}

run(main);
