import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, runAtomicWrite } from "@/db";
import {
  contactMerges,
  contacts,
  eventAttendees,
  noteBatches,
  outreachCampaigns,
  outreachProspects,
  suggestedReminders,
} from "@/db/schema";
import { deleteAvatarBlobs } from "@/lib/avatar-blob";

/**
 * Delete one contact and every structured row that is about them. The per-table rule, and
 * why, is in the launch Phase 2 plan (Task 12). Free text is deliberately not scrubbed: notes,
 * chat and transcripts the user wrote are theirs, and the delete dialog says they stay.
 *
 * What IS removed beyond the cascades is every id reference that has no foreign key to
 * cascade from — `privacy/probe-selective-deletion.ts` (S1) found the id surviving in five
 * tables, and a search passage of a group note still listing the deleted person, so chat could
 * still surface them.
 *
 * The one-id case of `deleteContactsForUser`, which holds the statements.
 */
export async function deleteContactForUser(
  userId: string,
  contactId: string
): Promise<{ deleted: boolean }> {
  const { deletedIds } = await deleteContactsForUser(userId, [contactId]);
  return { deleted: deletedIds.length > 0 };
}

/**
 * Delete many contacts the way `deleteContactForUser` deletes one, in the same number of
 * round trips as one: the two reads together, then one atomic group, then one Blob call.
 * On neon-http every statement is its own HTTPS request, so a per-contact loop over an
 * undone import cost three or more requests per person.
 *
 * One atomic group, contacts LAST: `event_attendees`, `outreach_prospects` and
 * `suggested_reminders` point at the contact with ON DELETE SET NULL, so deleting the contact
 * first would lose the link that says which rows to take.
 *
 * Only ids that exist and belong to `userId` are touched, and nothing is written when none
 * do. Callers pass a bounded chunk (the import undo sends ~100): every statement carries the
 * whole id list as parameters.
 */
export async function deleteContactsForUser(
  userId: string,
  contactIds: readonly string[]
): Promise<{ deletedIds: string[] }> {
  const requested = [...new Set(contactIds)];
  if (requested.length === 0) return { deletedIds: [] };

  const db = await getDb();
  // Independent reads, so they go out together. The snapshot read is scoped to `userId` on
  // its own, so running it before ownership is known reads nothing it should not.
  const [found, snapshots] = await Promise.all([
    db
      .select({ id: contacts.id, profileImageUrl: contacts.profileImageUrl })
      .from(contacts)
      .where(and(inArray(contacts.id, requested), eq(contacts.userId, userId))),
    db
      .select({ contactId: contactMerges.winnerContactId, snapshot: contactMerges.loserSnapshot })
      .from(contactMerges)
      .where(and(eq(contactMerges.userId, userId), inArray(contactMerges.winnerContactId, requested))),
  ]);
  if (found.length === 0) return { deletedIds: [] };

  const ids = found.map((c) => c.id);
  const owned = new Set(ids);
  const idArray = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
  const idText = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::text`), sql`, `)}]::text[]`;
  /** A jsonb array of ids, without these ids. */
  const withoutIds = (column: string) =>
    sql`(SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(${sql.raw(column)}) e
          WHERE (e #>> '{}') <> ALL(${idText}))`;
  const namesAny = (column: string) =>
    sql`jsonb_typeof(${sql.raw(column)}) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${sql.raw(column)}) e WHERE e = ANY(${idText}))`;
  const photos = [
    ...found.map((c) => c.profileImageUrl),
    ...snapshots
      .filter((s) => owned.has(s.contactId))
      .map((s) => {
        const url = (s.snapshot as Record<string, unknown>).profile_image_url;
        return typeof url === "string" ? url : null;
      }),
  ];

  await runAtomicWrite(db, (tx) => [
    tx.delete(eventAttendees).where(and(eq(eventAttendees.userId, userId), inArray(eventAttendees.contactId, ids))),
    tx.delete(outreachProspects).where(
      and(
        inArray(outreachProspects.contactId, ids),
        inArray(
          outreachProspects.campaignId,
          tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(eq(outreachCampaigns.userId, userId))
        )
      )
    ),
    tx.delete(suggestedReminders).where(and(eq(suggestedReminders.userId, userId), inArray(suggestedReminders.contactId, ids))),
    tx.delete(contactMerges).where(and(eq(contactMerges.userId, userId), inArray(contactMerges.winnerContactId, ids))),
    tx.update(noteBatches).set({ seedContactId: null }).where(and(eq(noteBatches.userId, userId), inArray(noteBatches.seedContactId, ids))),
    // Search passages filed under someone ELSE that also list these people (a group note).
    // Their own passages cascade on `contact_id`; these do not. An interaction's passages are
    // dropped so the memory sweep rebuilds them from the note — whose mentions of these
    // people cascade below, so the rebuilt passages no longer list them. Other kinds just
    // lose the id.
    tx.execute(sql`
      DELETE FROM memory_chunks
       WHERE user_id = ${userId} AND source_kind = 'interaction' AND contact_ids && ${idArray}
    `),
    tx.execute(sql`
      UPDATE memory_chunks
         SET contact_ids = (SELECT coalesce(array_agg(x), '{}'::uuid[]) FROM unnest(contact_ids) x WHERE x <> ALL(${idArray}))
       WHERE user_id = ${userId} AND contact_ids && ${idArray}
    `),
    // Ids held in plain columns and jsonb arrays, with no foreign key to cascade from.
    tx.execute(sql`
      UPDATE ai_suggestions SET related_contact_ids = ${withoutIds("related_contact_ids")}
       WHERE user_id = ${userId} AND ${namesAny("related_contact_ids")}
    `),
    tx.execute(sql`
      UPDATE email_sends SET contact_ids = ${withoutIds("contact_ids")}
       WHERE user_id = ${userId} AND ${namesAny("contact_ids")}
    `),
    tx.execute(sql`
      UPDATE capture_jobs SET seed_contact_id = NULL
       WHERE user_id = ${userId} AND seed_contact_id = ANY(${idArray})
    `),
    tx.execute(sql`
      UPDATE import_job_rows SET contact_id = NULL
       WHERE user_id = ${userId} AND contact_id = ANY(${idArray})
    `),
    // Every id filtered in one pass. `<> ALL` keeps the one-id filter's NULL behavior: an
    // element with no `id` compares NULL and is dropped, exactly as `e->>'id' <> $id` did.
    tx.execute(sql`
      UPDATE chat_messages
         SET attached_contacts = COALESCE(
               (SELECT jsonb_agg(e) FROM jsonb_array_elements(attached_contacts) e
                 WHERE e->>'id' <> ALL(ARRAY[${sql.join(ids.map((id) => sql`${id}::text`), sql`, `)}])),
               '[]'::jsonb)
       WHERE user_id = ${userId}
         AND attached_contacts @> ANY(ARRAY[${sql.join(
           ids.map((id) => sql`${JSON.stringify([{ id }])}::jsonb`),
           sql`, `
         )}])
    `),
    tx.delete(contacts).where(and(inArray(contacts.id, ids), eq(contacts.userId, userId))),
  ]);

  await deleteAvatarBlobs(photos);
  return { deletedIds: ids };
}
