/**
 * Find (and with --apply, delete) the contacts Radar's arXiv/GitHub discovery (#611) inserted
 * without asking. Discovery wrote exactly two shapes, with no `source`:
 *   - arXiv: title "Researcher · <paper>", company "Academic / Research", website = paper URL
 *   - GitHub: title "Builder · <repo>", website = repo URL
 * The code that wrote them is deleted; this clears what is already stored.
 *
 * A match is deletable only if nobody touched it since: no interactions, mentions, reminders,
 * tags, email, phone or LinkedIn URL. Everything else prints as "keep" with the reason, for a
 * human to look at.
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (see `requireRealDatabase`).
 *
 * Run: npx tsx scripts/cleanup-radar-discovery-contacts.ts [--apply]
 */
import { and, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactTags, contacts, interactionMentions, interactions, reminders } from "../src/db/schema";
import { deleteContactsForUser } from "../src/lib/contact-delete";

const CHUNK = 100;
/** #611 merged Nov 11 2026 02:35 UTC; nothing before this can be discovery's. */
const DISCOVERY_SHIPPED = new Date("2026-11-10T00:00:00Z");

export type DiscoveryMatch = {
  id: string;
  userId: string;
  fullName: string;
  title: string | null;
  website: string | null;
  keepReasons: string[];
  deletable: boolean;
};

export async function findDiscoveryContacts(since: Date = DISCOVERY_SHIPPED): Promise<DiscoveryMatch[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: contacts.id,
      userId: contacts.userId,
      fullName: contacts.fullName,
      title: contacts.title,
      website: contacts.website,
      email: contacts.email,
      phone: contacts.phone,
      linkedinUrl: contacts.linkedinUrl,
    })
    .from(contacts)
    .where(
      and(
        isNull(contacts.source),
        sql`${contacts.createdAt} >= ${since}`,
        sql`${contacts.website} IS NOT NULL`,
        or(
          and(sql`${contacts.title} LIKE 'Researcher · %'`, sql`${contacts.company} = 'Academic / Research'`),
          and(sql`${contacts.title} LIKE 'Builder · %'`, isNull(contacts.company))
        )
      )
    );

  const touched = new Map<string, Set<string>>();
  const mark = (id: string | null, why: string) => {
    if (!id) return;
    touched.set(id, (touched.get(id) ?? new Set()).add(why));
  };
  for (let i = 0; i < rows.length; i += CHUNK) {
    const ids = rows.slice(i, i + CHUNK).map((r) => r.id);
    const [ints, mentions, rems, tags] = await Promise.all([
      db.selectDistinct({ id: interactions.contactId }).from(interactions).where(inArray(interactions.contactId, ids)),
      db.selectDistinct({ id: interactionMentions.contactId }).from(interactionMentions).where(inArray(interactionMentions.contactId, ids)),
      db.selectDistinct({ id: reminders.contactId }).from(reminders).where(inArray(reminders.contactId, ids)),
      db.selectDistinct({ id: contactTags.contactId }).from(contactTags).where(inArray(contactTags.contactId, ids)),
    ]);
    for (const r of ints) mark(r.id, "interactions");
    for (const r of mentions) mark(r.id, "mentioned in a note");
    for (const r of rems) mark(r.id, "reminders");
    for (const r of tags) mark(r.id, "tags");
  }

  return rows.map((r) => {
    const keepReasons = [...(touched.get(r.id) ?? [])];
    if (r.email) keepReasons.push("email");
    if (r.phone) keepReasons.push("phone");
    if (r.linkedinUrl) keepReasons.push("LinkedIn URL");
    return {
      id: r.id,
      userId: r.userId,
      fullName: r.fullName,
      title: r.title,
      website: r.website,
      keepReasons,
      deletable: keepReasons.length === 0,
    };
  });
}

/** Deletes the deletable matches, per user, in bounded chunks. Returns the ids deleted. */
export async function deleteDiscoveryContacts(matches: DiscoveryMatch[]): Promise<string[]> {
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
  const { requireRealDatabase } = await import("./lib/operational-db");
  requireRealDatabase("cleanup-radar-discovery-contacts");
  const apply = process.argv.includes("--apply");

  const matches = await findDiscoveryContacts();
  for (const m of matches) {
    const verdict = m.deletable ? (apply ? "delete" : "would delete") : `keep (${m.keepReasons.join(", ")})`;
    console.log(`${verdict} ${m.id} user=${m.userId} "${m.fullName}" | ${m.title ?? ""} | ${m.website ?? ""}`);
  }
  const deletable = matches.filter((m) => m.deletable).length;
  const users = new Set(matches.map((m) => m.userId)).size;
  if (!apply) {
    console.log(`\n${matches.length} match(es) across ${users} account(s), ${deletable} deletable. Dry run: re-run with --apply to delete.`);
    return;
  }
  const deleted = await deleteDiscoveryContacts(matches);
  console.log(`\n${matches.length} match(es), ${deleted.length} deleted, ${matches.length - deleted.length} kept.`);
}

if (process.argv[1] && /cleanup-radar-discovery-contacts\.ts$/.test(process.argv[1])) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
