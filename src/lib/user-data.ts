import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  calendarSubscriptions,
  closenessCohorts,
  chatThreads,
  companies,
  contactEmbeddings,
  contactTags,
  contacts,
  billingEvents,
  errorEvents,
  feedback,
  gateEvents,
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
  recruiterMessages,
  userRecruiterLinks,
  userSettings,
} from "@/db/schema";
import { recomputeRecruiterRating } from "@/lib/recruiters";

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
 * Deliberate exceptions — two operator ledgers are NOT deleted, and both use a column
 * named something other than `user_id` to keep them out of the user-scoped sweep:
 *   - `admin_audit_log.target_user_id`: the operator's own record of privileged actions he
 *     took, chiefly comping a plan — which outranks every real billing signal and has no
 *     other trace. Purging it would mean deleting an account erases the evidence.
 *   - `webhook_deliveries.target_user_id`: the record of what Clerk actually sent,
 *     including the `user.deleted` event driving this very call. Deleting it would erase
 *     the evidence of the deletion itself.
 * A Clerk id is inert once the account is gone. `error_events`, by contrast, is data about
 * the user rather than about the operator, so it IS purged.
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

  await db.delete(closenessCohorts).where(eq(closenessCohorts.userId, userId));
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
  // `recruiters.avg_rating` / `rating_count` / `log_count` are denormalized counters over
  // `user_recruiter_links`, and nothing recomputes them on delete. Without this, every
  // account deletion permanently inflates those counters on each recruiter the user had
  // linked — the shared directory would drift further from the truth with each purge.
  const linkedRecruiterIds = (
    await db.query.userRecruiterLinks.findMany({
      where: eq(userRecruiterLinks.userId, userId),
      columns: { recruiterId: true },
    })
  ).map((l) => l.recruiterId);

  // The drafts and sent messages themselves, which carry `subject` and `body` — the user's
  // own prose to a named third party — plus the Gmail message and thread ids that locate
  // them in a real mailbox. Deleted before the links so the sweep below cannot leave a
  // message pointing at a recruiter the user is no longer linked to.
  //
  // This is the THIRD table to reach production user-scoped and unpurged, after
  // `outlook_connections` and `suggested_reminders`. `scripts/smoke-purge.ts` derives its
  // list from `schema.ts` precisely so a new one fails the suite — it did, and the failure
  // was sitting red on main.
  await db.delete(recruiterMessages).where(eq(recruiterMessages.userId, userId));

  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, userId));

  for (const recruiterId of new Set(linkedRecruiterIds)) {
    // Best-effort: a stale counter must not block deleting someone's data.
    await recomputeRecruiterRating(recruiterId).catch(() => {});
  }
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
  await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
  await db.delete(errorEvents).where(eq(errorEvents.userId, userId));

  // What they told us, and which walls they hit. Both are personal — one is literally
  // their own words — so erasure means erasure, even though the churn reasons are the
  // most valuable feedback Orbit gets and they are exactly the ones that leave with the
  // account. That trade is the right way round; keeping them would mean a user who asked
  // to be deleted still has their opinion on file.
  await db.delete(feedback).where(eq(feedback.userId, userId));
  await db.delete(gateEvents).where(eq(gateEvents.userId, userId));

  // ANONYMISED, NOT DELETED — the one deliberate exception in this function.
  //
  // `billing_events` is Orbit's accounting record: what was charged, refunded and earned.
  // Financial records have to survive a customer leaving, and deleting them would also
  // silently rewrite revenue history, so a month that has already been reported would
  // change months later. Nulling `user_id` severs the link to the person while leaving the
  // money intact, which is what "no longer identifiable" asks for.
  //
  // `scripts/smoke-purge.ts` counts rows `WHERE user_id = ...`, so this satisfies its
  // no-leak assertion honestly rather than by exemption.
  await db
    .update(billingEvents)
    .set({ userId: null })
    .where(eq(billingEvents.userId, userId));

  await db.delete(outreachCampaigns).where(eq(outreachCampaigns.userId, userId));

  // `contact_tags` has no `user_id` of its own, so it is deleted through its contacts. One
  // statement with a subquery, not a query for every contact followed by a delete for each —
  // that shape meant purging a 5,000-contact account took 5,001 round trips.
  await db.delete(contactTags).where(
    inArray(
      contactTags.contactId,
      db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, userId))
    )
  );
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(companies).where(eq(companies.userId, userId));
  await db.delete(tags).where(eq(tags.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
}
