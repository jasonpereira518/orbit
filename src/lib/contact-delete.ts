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
 * why, is in the launch Phase 2 plan (Task 12). Free text is deliberately not scrubbed.
 *
 * One atomic group, contact LAST: `event_attendees`, `outreach_prospects` and
 * `suggested_reminders` point at the contact with ON DELETE SET NULL, so deleting the contact
 * first would lose the link that says which rows to take.
 */
export async function deleteContactForUser(
  userId: string,
  contactId: string
): Promise<{ deleted: boolean }> {
  const db = await getDb();
  const [contact] = await db
    .select({ id: contacts.id, profileImageUrl: contacts.profileImageUrl })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  if (!contact) return { deleted: false };

  const snapshots = await db
    .select({ snapshot: contactMerges.loserSnapshot })
    .from(contactMerges)
    .where(and(eq(contactMerges.userId, userId), eq(contactMerges.winnerContactId, contactId)));
  const photos = [
    contact.profileImageUrl,
    ...snapshots.map((s) => {
      const url = (s.snapshot as Record<string, unknown>).profile_image_url;
      return typeof url === "string" ? url : null;
    }),
  ];

  await runAtomicWrite(db, (tx) => [
    tx.delete(eventAttendees).where(and(eq(eventAttendees.userId, userId), eq(eventAttendees.contactId, contactId))),
    tx.delete(outreachProspects).where(
      and(
        eq(outreachProspects.contactId, contactId),
        inArray(
          outreachProspects.campaignId,
          tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(eq(outreachCampaigns.userId, userId))
        )
      )
    ),
    tx.delete(suggestedReminders).where(and(eq(suggestedReminders.userId, userId), eq(suggestedReminders.contactId, contactId))),
    tx.delete(contactMerges).where(and(eq(contactMerges.userId, userId), eq(contactMerges.winnerContactId, contactId))),
    tx.update(noteBatches).set({ seedContactId: null }).where(and(eq(noteBatches.userId, userId), eq(noteBatches.seedContactId, contactId))),
    tx.execute(sql`
      UPDATE chat_messages
         SET attached_contacts = COALESCE(
               (SELECT jsonb_agg(e) FROM jsonb_array_elements(attached_contacts) e WHERE e->>'id' <> ${contactId}),
               '[]'::jsonb)
       WHERE user_id = ${userId}
         AND attached_contacts @> ${JSON.stringify([{ id: contactId }])}::jsonb
    `),
    tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId))),
  ]);

  await deleteAvatarBlobs(photos);
  return { deleted: true };
}
