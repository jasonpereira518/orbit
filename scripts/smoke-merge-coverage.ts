/**
 * Does `mergeContacts` know about every table that points at a contact?
 *
 * The merge deletes the loser's `contacts` row last, and most foreign keys to it are ON
 * DELETE CASCADE — so a child table the merge does not explicitly move is not "left behind",
 * it is DELETED, silently, and unmerge has nothing to put back. A hand-maintained list of
 * tables to check (as `smoke-contact-merge.ts` has) cannot notice a table added after it was
 * written. This script asks the live schema instead:
 *
 *   1. Every foreign key that references `contacts(id)` (pg_constraint), and every column
 *      whose name says it holds a contact id without a foreign key (`contact_id`,
 *      `seed_contact_id`, `contact_ids`, `related_contact_ids`).
 *   2. What the merge actually handles, read from the merge's own source: the
 *      `REPOINTED_TABLES` entries plus every `UPDATE <table>` / `DELETE FROM <table>` it
 *      issues. Reading the source rather than copying the list means a table the merge
 *      learns to move counts here with no edit to this file.
 *   3. Every referencing column must be handled, deliberately left to its ON DELETE rule
 *      (with the reason), or a documented known gap. A NEW table that is none of these fails
 *      here — which is the point: whoever adds a contact child table decides what a merge
 *      does with it.
 *
 * The known gaps are reproduced in `smoke-bug-merge-drops-children.ts` and
 * `smoke-bug-merge-email-sends.ts`. Then the round trip for the tables that ARE handled:
 * a loser with an interaction and a reminder merges, both survive on the winner, and unmerge
 * hands both back to the restored loser.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-merge-coverage.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contactMerges, contacts, interactions, reminders } from "../src/db/schema";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, insertInteraction, insertReminder, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("merge-coverage");

/**
 * Left to the loser's ON DELETE rule on purpose, each for the reason the merge's comments give.
 * `table.column` keys.
 */
const DELIBERATE: Record<string, string> = {
  // 4f: every pair naming the loser is resolved by the merge itself; repointing would collide.
  "duplicate_suggestions.contact_a_id": "pairs naming the loser cascade by design (merge step 4f)",
  "duplicate_suggestions.contact_b_id": "pairs naming the loser cascade by design (merge step 4f)",
  // The loser's digest cascades; the winner's watermark is reset so the next pass re-reads.
  "relationship_digests.contact_id": "re-derived after the merge; winner's watermark is cleared",
};

/** Not handled, and known: reproduced by the smoke-bug-merge-* scripts named here. */
const KNOWN_GAPS: Record<string, string> = {
  "contact_opportunities.contact_id": "smoke-bug-merge-drops-children (cascade-deleted)",
  "job_posting_matches.contact_id": "smoke-bug-merge-drops-children (cascade-deleted)",
  "agent_send_requests.contact_id": "smoke-bug-merge-drops-children (set null)",
  "email_sends.contact_ids": "smoke-bug-merge-email-sends (stale jsonb id)",
  // No foreign key and no reader that surfaces it: the job copies it onto the note batch it
  // saves, after the merge, so that batch names the merged-away id. Low; not a bug script.
  "capture_jobs.seed_contact_id": "stale id on a capture job queued before the merge (low, not surfaced)",
};

/** Every table the merge's own source moves, rewrites or archives. */
function tablesHandledBySource(): Set<string> {
  const source = readFileSync("src/lib/contact-merge.ts", "utf8");
  const merge = source.slice(
    source.indexOf("export async function mergeContacts"),
    source.indexOf("export async function invalidateAfterMerge")
  );
  const handled = new Set<string>();
  for (const m of source.matchAll(/\{\s*table:\s*"(\w+)",\s*column:\s*"(\w+)"/g)) handled.add(`${m[1]}.${m[2]}`);
  for (const m of merge.matchAll(/(?:UPDATE|DELETE FROM)\s+(\w+)/g)) handled.add(m[1]);
  return handled;
}

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  console.log("\nEvery reference to a contact is classified...");
  const fks = rowsOf<{ tbl: string; col: string; del: string }>(
    await db.execute(sql`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype AS del
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'contacts'::regclass
       ORDER BY 1, 2`)
  );
  const idColumns = rowsOf<{ tbl: string; col: string }>(
    await db.execute(sql`
      SELECT table_name AS tbl, column_name AS col FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND column_name IN ('contact_id', 'seed_contact_id', 'contact_ids', 'related_contact_ids')
       ORDER BY 1, 2`)
  );
  t.check("the catalogue reports foreign keys to contacts", fks.length >= 20, `found ${fks.length}`);

  const handled = tablesHandledBySource();
  t.check("the merge source parses (REPOINTED_TABLES found)", handled.has("interactions.contact_id"), [...handled].join(", "));

  const references = new Map<string, string>();
  for (const fk of fks) references.set(`${fk.tbl}.${fk.col}`, `fk on delete ${fk.del === "c" ? "cascade" : fk.del === "n" ? "set null" : fk.del}`);
  for (const c of idColumns) if (!references.has(`${c.tbl}.${c.col}`)) references.set(`${c.tbl}.${c.col}`, "no foreign key");

  const unclassified: string[] = [];
  for (const [key, kind] of references) {
    const table = key.split(".")[0];
    if (handled.has(key) || handled.has(table) || DELIBERATE[key] || KNOWN_GAPS[key]) continue;
    unclassified.push(`${key} (${kind})`);
  }
  t.check(
    "every column that references a contact is handled by the merge, deliberate, or a documented gap",
    unclassified.length === 0,
    unclassified.length ? `unclassified: ${unclassified.join(", ")}` : `${references.size} references`
  );

  // The allowlists must not rot into covering something that does not exist.
  const stale = [...Object.keys(DELIBERATE), ...Object.keys(KNOWN_GAPS)].filter((k) => !references.has(k));
  t.check("every allowlisted reference still exists in the schema", stale.length === 0, stale.join(", "));
  for (const [key, why] of Object.entries(KNOWN_GAPS)) {
    console.log(`        known gap: ${key} — ${why}${handled.has(key.split(".")[0]) ? " (now handled? re-check the bug script)" : ""}`);
  }

  console.log("\nA loser's interaction and reminder survive the merge on the winner...");
  const winner = await insertContact(db, USER, 2);
  const loser = await insertContact(db, USER, 2, { email: null, phone: null, linkedinUrl: null, title: null });
  const note = await insertInteraction(db, USER, loser.id);
  const reminder = await insertReminder(db, USER, loser.id, { title: "Send Alan the paper" });

  const { mergeId } = await mergeContacts(USER, winner.id, loser.id, { deferInvalidation: true });
  const [noteAfter] = await db.select().from(interactions).where(eq(interactions.id, note.id));
  const [reminderAfter] = await db.select().from(reminders).where(eq(reminders.id, reminder.id));
  t.check("the interaction now belongs to the winner", noteAfter?.contactId === winner.id);
  t.check("the reminder now belongs to the winner", reminderAfter?.contactId === winner.id);
  const loserGone = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, loser.id));
  t.check("the loser's contacts row is gone", loserGone.length === 0);
  const [archive] = await db.select().from(contactMerges).where(eq(contactMerges.id, mergeId));
  const repointed = (archive?.repointed ?? {}) as Record<string, string[]>;
  t.check("the archive recorded both moves", repointed.interactions?.includes(note.id) === true && repointed.reminders?.includes(reminder.id) === true);

  console.log("\n...and unmerge hands both back...");
  await unmergeContacts(USER, mergeId);
  const [noteBack] = await db.select().from(interactions).where(eq(interactions.id, note.id));
  const [reminderBack] = await db.select().from(reminders).where(eq(reminders.id, reminder.id));
  const [loserBack] = await db.select().from(contacts).where(and(eq(contacts.id, loser.id), eq(contacts.userId, USER)));
  t.check("the loser is back with its original id", Boolean(loserBack));
  t.check("the interaction is back on the loser", noteBack?.contactId === loser.id);
  t.check("the reminder is back on the loser", reminderBack?.contactId === loser.id);
  const archiveGone = await db.select().from(contactMerges).where(eq(contactMerges.id, mergeId));
  t.check("the archive row is consumed", archiveGone.length === 0);

  await purgeUsers(db, [USER]);
  t.done("merge coverage");
});
