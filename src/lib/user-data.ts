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
  outreachCampaigns,
  reminderLists,
  reminders,
  tags,
  userGoals,
  userRecruiterLinks,
  userSettings,
} from "@/db/schema";

/** Delete all Orbit data for a user (does not delete the Clerk account). */
export async function purgeUserData(userId: string) {
  const db = await getDb();

  await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
  await db.delete(interactions).where(eq(interactions.userId, userId));
  await db.delete(reminders).where(eq(reminders.userId, userId));
  await db.delete(reminderLists).where(eq(reminderLists.userId, userId));
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, userId));
  await db.delete(imports).where(eq(imports.userId, userId));
  await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.userId, userId));
  await db.delete(userGoals).where(eq(userGoals.userId, userId));
  await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, userId));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));

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
