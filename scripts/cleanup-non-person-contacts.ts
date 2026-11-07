/**
 * Find (and with --apply, delete) contacts that are not people: group and resource calendars,
 * rooms and mailboxes an older calendar sync saved as contacts. The rule is
 * `nonPersonContactSql` (`src/lib/non-person-participant.ts`); ingest now blocks new ones and
 * the People list hides the rest, so this only clears what is already stored.
 *
 * Dry run by default: prints every match with its id, name, email and interaction counts by
 * source. `--apply` deletes only the matches whose interactions all came from a calendar (or
 * that have none), through `deleteContactsForUser`. A match with a note, an email or anything
 * else a person might have logged is printed as kept, for a human to look at.
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (see `requireRealDatabase`).
 *
 * Run: npx tsx scripts/cleanup-non-person-contacts.ts [--apply]
 */
import { inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions } from "../src/db/schema";
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
  deletable: boolean;
};

export async function findNonPersonContacts(): Promise<NonPersonMatch[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: contacts.id, userId: contacts.userId, fullName: contacts.fullName, email: contacts.email })
    .from(contacts)
    .where(nonPersonContactSql());
  const sources = new Map<string, Record<string, number>>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const ids = rows.slice(i, i + CHUNK).map((r) => r.id);
    const counts = await db
      .select({ contactId: interactions.contactId, source: interactions.source, n: sql<number>`count(*)::int` })
      .from(interactions)
      .where(inArray(interactions.contactId, ids))
      .groupBy(interactions.contactId, interactions.source);
    for (const c of counts) {
      const bySource = sources.get(c.contactId) ?? {};
      bySource[c.source ?? "(none)"] = Number(c.n);
      sources.set(c.contactId, bySource);
    }
  }
  return rows.map((r) => {
    const bySource = sources.get(r.id) ?? {};
    return { ...r, sources: bySource, deletable: Object.keys(bySource).every((s) => CALENDAR_SOURCES.has(s)) };
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
    console.log(`${m.deletable ? (apply ? "delete" : "would delete") : "keep"} ${m.id} user=${m.userId} "${m.fullName}" <${m.email ?? ""}> ${counts}`);
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
