/**
 * Find (and with --apply, delete) contacts that are not people: group and resource calendars,
 * rooms and mailboxes an older calendar sync saved as contacts. The rule is
 * `nonPersonContactSql` (`src/lib/non-person-participant.ts`); ingest now blocks new ones and
 * the People list hides the rest, so this only clears what is already stored.
 *
 * Dry run by default: prints every match with its id, name, email and interaction counts by
 * source. `--apply` deletes, through `deleteContactsForUser`, only a match that a calendar made
 * and nobody touched since: `contacts.source` is a calendar source, every interaction (if any)
 * is calendar-sourced, and it has no tags, reminders, LinkedIn URL or key facts. Every other
 * match is printed as "keep" with the reason, for a human to look at.
 *
 * Scans the whole `contacts` table (every user) with the predicate; there is no index on it,
 * which is fine for a one-off.
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (see `requireRealDatabase`).
 *
 * Run: npx tsx scripts/cleanup-non-person-contacts.ts [--apply]
 */
import { inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactTags, contacts, interactions, reminders } from "../src/db/schema";
import { deleteContactsForUser } from "../src/lib/contact-delete";
import { nonPersonContactSql } from "../src/lib/non-person-participant";

/** Same list `embedding-backfill.ts` treats as calendar-sourced. */
const CALENDAR_SOURCES = new Set(["calendar_import", "calendar_sync", "google_calendar", "microsoft_calendar", "apple_calendar"]);
const CHUNK = 100;

export type NonPersonMatch = {
  id: string;
  userId: string;
  fullName: string;
  email: string | null;
  /** Interaction counts keyed by `interactions.source` ("(none)" for NULL). */
  sources: Record<string, number>;
  /** Why a match is kept; empty when it is deletable. */
  keepReasons: string[];
  deletable: boolean;
};

const countBy = (rows: { contactId: string | null; n: number }[]) =>
  new Map(rows.map((r) => [r.contactId ?? "", Number(r.n)]));

export async function findNonPersonContacts(): Promise<NonPersonMatch[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: contacts.id,
      userId: contacts.userId,
      fullName: contacts.fullName,
      email: contacts.email,
      source: contacts.source,
      linkedinUrl: contacts.linkedinUrl,
      keyFacts: contacts.keyFacts,
    })
    .from(contacts)
    .where(nonPersonContactSql());
  const sources = new Map<string, Record<string, number>>();
  const tags = new Map<string, number>();
  const reminderCounts = new Map<string, number>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const ids = rows.slice(i, i + CHUNK).map((r) => r.id);
    const n = sql<number>`count(*)::int`;
    const [counts, tagRows, reminderRows] = await Promise.all([
      db
        .select({ contactId: interactions.contactId, source: interactions.source, n })
        .from(interactions)
        .where(inArray(interactions.contactId, ids))
        .groupBy(interactions.contactId, interactions.source),
      db.select({ contactId: contactTags.contactId, n }).from(contactTags).where(inArray(contactTags.contactId, ids)).groupBy(contactTags.contactId),
      db.select({ contactId: reminders.contactId, n }).from(reminders).where(inArray(reminders.contactId, ids)).groupBy(reminders.contactId),
    ]);
    for (const c of counts) {
      const bySource = sources.get(c.contactId) ?? {};
      bySource[c.source ?? "(none)"] = Number(c.n);
      sources.set(c.contactId, bySource);
    }
    for (const [id, k] of countBy(tagRows)) tags.set(id, k);
    for (const [id, k] of countBy(reminderRows)) reminderCounts.set(id, k);
  }
  return rows.map((r) => {
    const bySource = sources.get(r.id) ?? {};
    const keepReasons = [
      !CALENDAR_SOURCES.has(r.source ?? "") && `source ${r.source ?? "(none)"}`,
      Object.keys(bySource).some((s) => !CALENDAR_SOURCES.has(s)) && "non-calendar interactions",
      tags.has(r.id) && "tagged",
      reminderCounts.has(r.id) && "has reminders",
      r.linkedinUrl && "has LinkedIn URL",
      r.keyFacts?.length && "has key facts",
    ].filter((x): x is string => typeof x === "string");
    return {
      id: r.id,
      userId: r.userId,
      fullName: r.fullName,
      email: r.email,
      sources: bySource,
      keepReasons,
      deletable: keepReasons.length === 0,
    };
  });
}

/** Deletes the deletable matches, per user, in bounded chunks. Returns the ids deleted. */
export async function deleteNonPersonContacts(matches: NonPersonMatch[]): Promise<string[]> {
  const byUser = new Map<string, string[]>();
  for (const m of matches) if (m.deletable) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m.id]);
  const deleted: string[] = [];
  for (const [userId, ids] of byUser) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      deleted.push(...(await deleteContactsForUser(userId, ids.slice(i, i + CHUNK))).deletedIds);
    }
  }
  return deleted;
}

async function main() {
  // Imported here, not at the top: its dotenv load would refill the DATABASE_URL a smoke's
  // `_env` preamble deleted, and the smoke imports this file for the two functions above.
  const { requireRealDatabase } = await import("./lib/operational-db");
  requireRealDatabase("cleanup-non-person-contacts");
  const apply = process.argv.includes("--apply");

  const matches = await findNonPersonContacts();
  for (const m of matches) {
    const counts = Object.entries(m.sources).map(([s, n]) => `${s}=${n}`).join(" ") || "no interactions";
    const verdict = m.deletable ? (apply ? "delete" : "would delete") : `keep (${m.keepReasons.join(", ")})`;
    console.log(`${verdict} ${m.id} user=${m.userId} "${m.fullName}" <${m.email ?? ""}> ${counts}`);
  }
  const deletable = matches.filter((m) => m.deletable).length;
  if (!apply) {
    console.log(`\n${matches.length} match(es), ${deletable} deletable. Dry run: re-run with --apply to delete.`);
    return;
  }
  const deleted = await deleteNonPersonContacts(matches);
  console.log(`\n${matches.length} match(es), ${deleted.length} deleted, ${matches.length - deleted.length} kept.`);
}

if (process.argv[1] && /cleanup-non-person-contacts\.ts$/.test(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
