import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  calendarSubscriptions,
  chatThreads,
  companies,
  contactEmbeddings,
  contactTags,
  contacts,
  gmailConnections,
  imports,
  interactions,
  outlookConnections,
  outreachCampaigns,
  reminderLists,
  reminders,
  suggestedReminders,
  tags,
  usageEvents,
  userGoals,
  userRecruiterLinks,
  userSettings,
} from "@/db/schema";

/**
 * Delete all Orbit data for a user (does not delete the Clerk account).
 *
 * Every table carrying a `user_id` must be handled here, either by an explicit delete or
 * by a cascade from one. The two covered by cascade, so deliberately absent below:
 *   - `chat_messages`   → cascades from `chat_threads`
 *   - `import_job_rows` → cascades from `imports`
 * Nothing else may be omitted. `suggested_reminders` looks like it would cascade but does
 * not: both of its foreign keys are `on delete set null`, so its rows outlive the reminders
 * and contacts they point at. `outlook_connections` has no parent at all.
 *
 * Deliberate exception: `admin_audit_log` rows referencing this user are NOT deleted.
 * That table is the operator's own record of privileged actions he took — chiefly comping
 * a plan, which outranks every real billing signal and has no other trace. Purging it here
 * would mean deleting an account erases the evidence that it was ever comped or inspected.
 * A Clerk id is inert once the account is gone.
 *
 * `scripts/smoke-purge.ts` asserts this leaves nothing behind, table by table.
 */
export async function purgeUserData(userId: string) {
  const db = await getDb();

  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
  await db.delete(interactions).where(eq(interactions.userId, userId));
  // Before `reminders` and `contacts`: its FKs are `set null`, so deleting those first
  // would rewrite these rows on the way to deleting them anyway.
  await db.delete(suggestedReminders).where(eq(suggestedReminders.userId, userId));
  await db.delete(reminders).where(eq(reminders.userId, userId));
  await db.delete(reminderLists).where(eq(reminderLists.userId, userId));
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, userId));
  await db.delete(imports).where(eq(imports.userId, userId));
  await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.userId, userId));
  await db.delete(userGoals).where(eq(userGoals.userId, userId));
  await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, userId));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
  await db.delete(usageEvents).where(eq(usageEvents.userId, userId));

  await db.delete(outreachCampaigns).where(eq(outreachCampaigns.userId, userId));

  const userContacts = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });
  for (const c of userContacts) {
    await db.delete(contactTags).where(eq(contactTags.contactId, c.id));
  }
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(companies).where(eq(companies.userId, userId));
  await db.delete(tags).where(eq(tags.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
}
