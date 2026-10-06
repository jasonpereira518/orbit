import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  companies,
  contactMerges,
  contacts,
  suggestedReminders,
} from "@/db/schema";
import { markCohortDirty } from "@/lib/closeness-materialize";
import { normalizeCompanyKey } from "@/lib/company-name";
import { EXAMPLE_COMPANY_NAMES, EXAMPLE_FULL_NAMES } from "@/lib/onboarding-examples/cast";
import { TOUR_EXAMPLE_SOURCE } from "@/lib/onboarding-examples/marker";

/**
 * Removes the tour's example people and everything that hangs off them.
 *
 * The root is `contacts.source = 'tour-example'`; briefs, action items, interactions,
 * mentions, reminders, chunks, embeddings and tags all cascade from the contact. Two
 * things need care beyond that:
 *
 *  - A merge. Someone may have merged a real person into an example (or the reverse) during
 *    the tour. An example that WON a merge holds real data now, so it is unmarked rather
 *    than deleted; `contact-merge.ts` already refuses to relabel a real winner as an
 *    example, and this is the belt to that brace.
 *  - A twin. The Capture stop pre-fills a note about an example person. If the matcher
 *    missed and created a fresh, unmarked contact with the same name during the tour
 *    (`since`), that twin is an example in every way that matters and goes too.
 *
 * Rows that reference a deleted contact through a `set null` key (suggested reminders,
 * pending AI suggestions) are deleted first rather than left as headless tombstones.
 */
export async function removeTourExamples(
  userId: string,
  opts: { since?: Date | string | null } = {},
): Promise<{ removed: number }> {
  const db = await getDb();

  const marked = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.source, TOUR_EXAMPLE_SOURCE)));
  let ids = marked.map((r) => r.id);

  if (ids.length) {
    const winners = await db
      .select({ id: contactMerges.winnerContactId })
      .from(contactMerges)
      .where(and(eq(contactMerges.userId, userId), inArray(contactMerges.winnerContactId, ids)));
    const keep = new Set(winners.map((w) => w.id));
    if (keep.size) {
      await db
        .update(contacts)
        .set({ source: null })
        .where(and(eq(contacts.userId, userId), inArray(contacts.id, [...keep])));
      ids = ids.filter((id) => !keep.has(id));
    }
  }

  const since = opts.since ? new Date(opts.since) : null;
  if (since) {
    const twins = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          or(isNull(contacts.source), ne(contacts.source, TOUR_EXAMPLE_SOURCE)),
          gte(contacts.createdAt, since),
          inArray(
            sql`lower(btrim(${contacts.fullName}))`,
            EXAMPLE_FULL_NAMES.map((n) => n.toLowerCase()),
          ),
          // An ex-example that won a merge has been unmarked above precisely because it now
          // holds a real person's data; its cast name must not pull it back in here.
          sql`NOT EXISTS (SELECT 1 FROM ${contactMerges} m WHERE m.user_id = ${userId} AND m.winner_contact_id = ${contacts.id})`,
        ),
      );
    for (const t of twins) if (!ids.includes(t.id)) ids.push(t.id);
  }

  if (ids.length) {
    await db
      .delete(suggestedReminders)
      .where(and(eq(suggestedReminders.userId, userId), inArray(suggestedReminders.contactId, ids)));
    await db.delete(aiSuggestions).where(
      and(
        eq(aiSuggestions.userId, userId),
        eq(aiSuggestions.status, "pending"),
        sql`${aiSuggestions.relatedContactIds} ?| ARRAY[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::text[]`,
      ),
    );
    await db.delete(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)));
  }

  // The cast's companies, once nobody is left at them.
  await db.delete(companies).where(
    and(
      eq(companies.userId, userId),
      inArray(companies.nameNormalized, EXAMPLE_COMPANY_NAMES.map(normalizeCompanyKey)),
      sql`NOT EXISTS (SELECT 1 FROM ${contacts} c WHERE c.company_id = ${companies.id})`,
    ),
  );

  if (ids.length) await markCohortDirty(userId).catch(() => null);
  return { removed: ids.length };
}
