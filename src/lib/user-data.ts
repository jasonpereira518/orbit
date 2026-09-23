import { cancelBatchJobsFor } from "@/lib/ai-batch";
import { del } from "@vercel/blob";
import { revokeGoogleGrant } from "@/lib/oauth-revoke";
import { OUTLOOK_SCAN_IMPORT_TYPE } from "@/lib/outlook-scan-type";
import { deleteAvatarBlobs } from "@/lib/avatar-blob";
import { and, asc, eq, getTableName, inArray, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb, rowsOf } from "@/db";
import {
  actionItems,
  aiSuggestions,
  apiIdempotencyKeys,
  agentSendRequests,
  apiKeys,
  billingEvents,
  calendarSubscriptions,
  captureHandoffs,
  captureJobs,
  capturePhotos,
  aiBatchJobs,
  aiResultCache,
  chatMessages,
  chatThreads,
  closenessCohorts,
  companies,
  connectorConnections,
  connectorOutbox,
  contactBriefs,
  contactEmbeddings,
  memoryChunks,
  contactExperiences,
  contactIdentities,
  contactMerges,
  contactProfiles,
  contacts,
  contactTags,
  dataPurgeRuns,
  duplicateSuggestions,
  embeddingFailures,
  errorEvents,
  eventAliases,
  eventAttendees,
  eventCompanies,
  eventProviderConnections,
  events,
  extensionUsage,
  externalLinks,
  feedback,
  feedbackScreenshots,
  gateEvents,
  gmailConnections,
  ignoredPeople,
  importJobRows,
  imports,
  interactionMentions,
  interactions,
  meetingSessions,
  meetingTranscriptSegments,
  noteBatches,
  outboundWebhookDeliveries,
  outlookConnections,
  outreachCampaigns,
  pageViews,
  planUpgradeEvents,
  recruiterMessages,
  recruiters,
  recruiterScanState,
  reminderLists,
  reminders,
  suggestedReminders,
  tags,
  targetCompanies,
  type DataPurgeRunRow,
  usageEvents,
  userGoals,
  userRecruiterLinks,
  userSettings,
  webhookEndpoints,
} from "@/db/schema";
import { purgeCapturePhotosForUser } from "@/lib/capture-photos";
import { recomputeRecruiterRating,
  RECRUITER_DELETED_CREATOR,
  rederiveSharedRecruiterPii,
} from "@/lib/recruiters";
import {
  DATA_CATEGORY_IDS,
  DATA_CATEGORY_META,
  expandCategories,
  type DataCategory,
  PURGE_MAX_ATTEMPTS,
  planPurgeSteps,
  type PurgeStepKey,
  isDataCategory,
} from "@/lib/data-categories";

export {
  DATA_CATEGORY_IDS,
  DATA_CATEGORY_META,
  expandCategories,
  type DataCategory,
};

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * The delete statements themselves, keyed by category id.
 *
 * There is exactly one list of deletes in Orbit and it is the one below: `purgeUserData`
 * with no `only` runs every step, in the order `DATA_CATEGORY_META` gives, and the settings
 * dialog runs a subset of the same steps. A selective delete that had its own statements
 * would drift from the full purge within a release, and the drift would be silent — which is
 * the same bug class `scripts/smoke-purge.ts` exists to catch.
 *
 * Every table carrying a `user_id` must be handled by some step here, either by an explicit
 * delete or by a cascade from one. The nine covered by cascade, so deliberately absent:
 *   - `chat_messages`        -> cascades from `chat_threads`
 *   - `import_job_rows`      -> cascades from `imports`
 *   - `action_items`         -> cascades from `contacts` and `interactions`
 *   - `contact_briefs`       -> cascades from `contacts`
 *   - `interaction_mentions` -> cascades from `contacts` and `interactions`
 *   - `contact_profiles`     -> cascades from `contacts` (verified by `scripts/smoke-purge.ts`,
 *                               not assumed — see that script's header)
 *   - `contact_experiences`  -> cascades from `contacts` (same)
 *   - `contact_opportunities`-> cascades from `contacts`. Its `source_interaction_id` is
 *                               `on delete set null`, so the interaction FK is NOT what
 *                               covers it — the contact one is.
 *   - `job_posting_matches`  -> cascades from `contacts` (and from `job_postings`, which is
 *                               global and never deleted with an account). The match is the
 *                               only per-user row in the job-feed trio; the feed itself and
 *                               its postings are global and carry no `user_id`.
 * Nothing else may be omitted. A `user_id` column is not on its own evidence of a cascade:
 * `note_batches` and `extension_usage` both have one and neither has a foreign key to
 * anything, so both are deleted explicitly. `suggested_reminders` looks like it would cascade
 * but does not: both of its foreign keys are `on delete set null`, so its rows outlive the
 * reminders and contacts they point at. `outlook_connections` has no parent at all.
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
 * the user rather than about the operator, so it IS purged (by `activity`).
 */
/** One dataset of a category's export: a page of this user's rows, snake_case keys. */
export type ExportSource = {
  name: string;
  page: (userId: string, limit: number, offset: number) => SQL;
  transform?: (row: Record<string, unknown>) => Record<string, unknown>;
};

/** Every row of `table` whose `user_id` is this user, in a stable order. */
export function ownRowsSource(table: PgTable, orderBy = "id"): ExportSource {
  const name = getTableName(table);
  return {
    name,
    page: (userId, limit, offset) =>
      sql`SELECT * FROM ${sql.identifier(name)} WHERE user_id = ${userId} ORDER BY ${sql.identifier(orderBy)} LIMIT ${limit} OFFSET ${offset}`,
  };
}

const own = ownRowsSource;
const joined = (name: string, page: ExportSource["page"]): ExportSource => ({ name, page });
const withUrl = (source: ExportSource, prefix: string): ExportSource => ({
  ...source,
  transform: (row) => ({ ...row, url: `${prefix}${String(row.id)}` }),
});
const contactsSource: ExportSource = {
  ...own(contacts),
  // Inline bytes and public Blob URLs become the owner-only avatar route.
  transform: (row) => {
    const url = typeof row.profile_image_url === "string" ? row.profile_image_url : null;
    const proxied = url && (url.startsWith("data:") || url.includes(".public.blob.vercel-storage.com"));
    return { ...row, profile_image_url: proxied ? `/api/avatars/${String(row.id)}` : url };
  },
};

type CategoryStep = {
  /** What this category exports — one dataset per table, same boundary as the delete. */
  exports: ExportSource[];
  /**
   * User-scoped tables whose rows are counted for the figure beside the checkbox. Join
   * tables with no `user_id` of their own (`contact_tags`) are deleted by the step but
   * cannot be counted here, and are left out rather than approximated.
   */
  counts: PgTable[];
  run: (db: Db, userId: string) => Promise<void>;
};

const STEPS: Record<DataCategory, CategoryStep> = {
  insights: {
    exports: [own(aiSuggestions), own(contactEmbeddings), own(memoryChunks), own(closenessCohorts, "user_id"), own(aiResultCache), own(aiBatchJobs)],
    counts: [aiSuggestions, contactEmbeddings, memoryChunks, closenessCohorts],
    run: async (db, userId) => {
      // Background AI still in flight at a provider. Cancelled there first — the provider is
      // holding this person's prompts, and deleting our row would only lose the handle to
      // them. Best effort: the rows go either way.
      await cancelBatchJobsFor(userId).catch(() => 0);
      await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, userId));
      // Remembered AI answers (recruiter verdicts, profile reads, drafts): derived from this
      // person's mail and contacts, and rebuilt on the next ask.
      await db.delete(aiResultCache).where(eq(aiResultCache.userId, userId));
      await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, userId));
      await db.delete(closenessCohorts).where(eq(closenessCohorts.userId, userId));
      await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
      // Passages of the person's own notes. Derived, but derived from the most personal text
      // in the product — leaving these behind after a deletion would leave the notes behind.
      await db.delete(memoryChunks).where(eq(memoryChunks.userId, userId));
      await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, userId));
    },
  },
  notes: {
    exports: [own(interactions), own(noteBatches), own(interactionMentions), own(actionItems), own(meetingSessions), own(meetingTranscriptSegments), own(captureJobs), own(captureHandoffs), own(ignoredPeople), withUrl(own(capturePhotos), "/api/capture/photos/")],
    counts: [
      interactions,
      noteBatches,
      meetingSessions,
      captureJobs,
      ignoredPeople,
    ],
    run: async (db, userId) => {
      // Capture photos before the batches they belong to. The rows WOULD cascade from
      // `note_batches`, but an unattached photo (a capture that was never saved) has no
      // batch to cascade from, and the Blob objects behind all of them have no foreign key
      // at all — the same reason feedback screenshots are removed by hand in `feedback`.
      await purgeCapturePhotosForUser(userId);
      // `note_batches` holds the raw pasted note text and has no cascading FK to `contacts`
      // or `interactions` — `seed_contact_id`, `reminders.note_batch_id` and
      // `interactions.note_batch_id` are all plain columns with no foreign key, so it
      // survives every other delete here unless removed explicitly. `source_text` is the
      // user's own prose about named people, which makes it the most sensitive row in the
      // file.
      await db.delete(noteBatches).where(eq(noteBatches.userId, userId));
      // Meeting transcripts: the words of everyone on a call, verbatim. Segments first and
      // explicitly, though they cascade from the session — they carry their own `user_id`,
      // and a transcript that outlived its account would be the worst leak this function
      // could have.
      await db
        .delete(meetingTranscriptSegments)
        .where(eq(meetingTranscriptSegments.userId, userId));
      await db.delete(meetingSessions).where(eq(meetingSessions.userId, userId));
      await db.delete(interactions).where(eq(interactions.userId, userId));
      // Short-lived by construction — claimed on pickup, swept on expiry — but a scan
      // started minutes before the account was deleted would otherwise leave a live grant
      // and a transcript of the user's notes behind it.
      await db.delete(captureHandoffs).where(eq(captureHandoffs.userId, userId));
      // A capture mid-review holds the user's own notes in `source_text` and every
      // extracted profile in `result`; the ignored list holds names from those notes.
      await db.delete(captureJobs).where(eq(captureJobs.userId, userId));
      await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, userId));
    },
  },
  reminders: {
    exports: [own(reminders), own(reminderLists), own(suggestedReminders)],
    counts: [reminders, reminderLists, suggestedReminders],
    run: async (db, userId) => {
      // Before `reminders` (and before `contacts`, further down): its FKs are `set null`,
      // so deleting those first would rewrite these rows on the way to deleting them anyway.
      await db.delete(suggestedReminders).where(eq(suggestedReminders.userId, userId));
      await db.delete(reminders).where(eq(reminders.userId, userId));
      await db.delete(reminderLists).where(eq(reminderLists.userId, userId));
    },
  },
  imports: {
    exports: [own(imports), own(importJobRows)],
    counts: [imports],
    run: async (db, userId) => {
      await db.delete(imports).where(eq(imports.userId, userId));
    },
  },
  connections: {
    exports: [
      own(gmailConnections),
      own(outlookConnections),
      own(calendarSubscriptions),
      own(eventProviderConnections),
      own(connectorConnections),
      own(externalLinks),
      own(connectorOutbox),
    ],
    counts: [
      gmailConnections,
      outlookConnections,
      calendarSubscriptions,
      eventProviderConnections,
      connectorConnections,
      externalLinks,
      connectorOutbox,
    ],
    run: async (db, userId) => {
      // Read before the delete: once the row is gone there is nothing to revoke with.
      const googleGrants = await db
        .select({
          refreshTokenEncrypted: gmailConnections.refreshTokenEncrypted,
          accessTokenEncrypted: gmailConnections.accessTokenEncrypted,
        })
        .from(gmailConnections)
        .where(eq(gmailConnections.userId, userId));
      await db.delete(calendarSubscriptions).where(eq(calendarSubscriptions.userId, userId));
      await db.delete(gmailConnections).where(eq(gmailConnections.userId, userId));
      // Best-effort and time-boxed (see oauth-revoke.ts): a Google outage must never
      // block an erasure. Outlook has no per-app revoke endpoint; Luma keys and Eventbrite
      // tokens have none Orbit can call.
      for (const grant of googleGrants) await revokeGoogleGrant(grant);
      await db.delete(outlookConnections).where(eq(outlookConnections.userId, userId));
      // Holds an encrypted Luma API key or Eventbrite access token. Same class of secret as
      // the Gmail/Outlook rows above, and it must not outlive the account.
      await db
        .delete(eventProviderConnections)
        .where(eq(eventProviderConnections.userId, userId));
      // Holds encrypted OAuth tokens, API keys and iCloud app passwords for every connector
      // that is not Gmail or Outlook. Same class of secret as the rows above, and it must
      // not outlive the account.
      await db.delete(connectorConnections).where(eq(connectorConnections.userId, userId));
      // The outbox may hold an unsent payload and external_links maps this user's rows into
      // other systems. Both go with the connection that produced them.
      await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, userId));
      await db.delete(externalLinks).where(eq(externalLinks.userId, userId));
    },
  },
  events: {
    exports: [own(events), own(eventAttendees), own(eventCompanies), own(eventAliases)],
    counts: [events, eventAttendees],
    run: async (db, userId) => {
      // Before `contacts`: `event_attendees.contact_id` is `on delete set null`, so deleting
      // contacts first would rewrite every one of these rows on the way to deleting them.
      // Attendees are deleted explicitly rather than left to the cascade from `events` —
      // they carry their own `user_id` (which is why `smoke-purge` finds them), and a roster
      // holds names, emails and employers of people the user met.
      await db.delete(eventAttendees).where(eq(eventAttendees.userId, userId));
      // Cascades from `events`, and deleted explicitly for the same reason `eventAttendees`
      // is: it carries its own `user_id`, so `smoke-purge` requires it, and leaving it to a
      // cascade means a change to the FK silently strips it from account deletion.
      await db.delete(eventCompanies).where(eq(eventCompanies.userId, userId));
      // Before `events`, and explicitly: an alias row survives its event by design (`on
      // delete set null` is what makes a dismissal stick), so deleting events first would
      // leave a tombstone per event behind — a list of every Luma link and calendar UID the
      // user ever had, pointing at nothing, outliving the account.
      await db.delete(eventAliases).where(eq(eventAliases.userId, userId));
      await db.delete(events).where(eq(events.userId, userId));
    },
  },
  goals: {
    exports: [own(userGoals)],
    counts: [userGoals],
    run: async (db, userId) => {
      await db.delete(userGoals).where(eq(userGoals.userId, userId));
    },
  },
  chat: {
    exports: [own(chatThreads), own(chatMessages)],
    counts: [chatThreads],
    run: async (db, userId) => {
      await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
    },
  },
  recruiters: {
    exports: [
      joined("user_recruiter_links", (userId, limit, offset) => sql`SELECT l.*, r.full_name AS recruiter_full_name, r.firm AS recruiter_firm FROM user_recruiter_links l JOIN recruiters r ON r.id = l.recruiter_id WHERE l.user_id = ${userId} ORDER BY l.id LIMIT ${limit} OFFSET ${offset}`),
      own(recruiterMessages),
      own(recruiterScanState),
    ],
    counts: [userRecruiterLinks, recruiterMessages],
    run: async (db, userId) => {
      // `recruiters.avg_rating` / `rating_count` / `log_count` are denormalized counters over
      // `user_recruiter_links`, and nothing recomputes them on delete. Without the recompute
      // below, every deletion permanently inflates those counters on each recruiter the user
      // had linked — the shared directory would drift further from the truth every time.
      const departingLinks = await db.query.userRecruiterLinks.findMany({
        where: eq(userRecruiterLinks.userId, userId),
        columns: { recruiterId: true, email: true, phone: true, linkedinUrl: true },
      });
      const linkedRecruiterIds = departingLinks.map((l) => l.recruiterId);

      // The drafts and sent messages themselves, which carry `subject` and `body` — the
      // user's own prose to a named third party — plus the Gmail message and thread ids that
      // locate them in a real mailbox. Deleted before the links so this cannot leave a
      // message pointing at a recruiter the user is no longer linked to.
      //
      // This was the THIRD table to reach production user-scoped and unpurged, after
      // `outlook_connections` and `suggested_reminders`. `scripts/smoke-purge.ts` derives its
      // list from `schema.ts` precisely so a new one fails the suite — it did, and the
      // failure was sitting red on main.
      await db.delete(recruiterMessages).where(eq(recruiterMessages.userId, userId));
      await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, userId));

      // Third-party PII nobody else holds: a canonical row whose only links were this user's.
      const ids = [...new Set(linkedRecruiterIds)];
      if (ids.length > 0) {
        await db.execute(sql`
          DELETE FROM recruiters r
           WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
             AND NOT EXISTS (SELECT 1 FROM user_recruiter_links l WHERE l.recruiter_id = r.id)
        `);
      }
      await db
        .update(recruiters)
        .set({ createdByUserId: RECRUITER_DELETED_CREATOR })
        .where(eq(recruiters.createdByUserId, userId));
      // What this user contributed to rows others still use leaves with them.
      for (const link of departingLinks) {
        await rederiveSharedRecruiterPii(link.recruiterId, { withdrawn: link }).catch(() => {});
      }

      for (const recruiterId of new Set(linkedRecruiterIds)) {
        // Best-effort: a stale counter must not block deleting someone's data.
        await recomputeRecruiterRating(recruiterId).catch(() => {});
      }
      // The recruiter scan's watermark. Not derived from `gmail_connections`, so it
      // survives a disconnect/reconnect on purpose — but it must not survive the account.
      await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, userId));
      // The Outlook scan's watermark is not a row of its own: it is the newest completed scan
      // job's frozen start time (`lastCompletedScanStart`). Left behind, "disconnect and delete
      // what was imported" would remove the recruiters but keep the record of having read the
      // mailbox, and the next Outlook scan would run incrementally — never re-reading the
      // history it just deleted. The rows cascade to `import_job_rows`.
      await db
        .delete(imports)
        .where(and(eq(imports.userId, userId), eq(imports.importType, OUTLOOK_SCAN_IMPORT_TYPE)));
    },
  },
  api: {
    exports: [
      own(apiKeys),
      own(webhookEndpoints),
      own(outboundWebhookDeliveries),
      own(apiIdempotencyKeys, "idempotency_key"),
      own(agentSendRequests),
    ],
    counts: [
      apiKeys,
      webhookEndpoints,
      outboundWebhookDeliveries,
      apiIdempotencyKeys,
      agentSendRequests,
    ],
    run: async (db, userId) => {
      // `api_keys` matters most: a key that outlives the data it reaches is a live credential
      // with nothing behind it. The deliveries go before the endpoints they reference,
      // because the FK cascades and the other order would rewrite rows on the way to
      // deleting them. `api_idempotency_keys` is a replay guard rather than content, but the
      // rule here admits no exceptions that are not written down — and this is the fifth
      // user-scoped table family caught by `scripts/smoke-purge.ts` rather than by review.
      await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
      // Drafts an assistant wrote. They hold message bodies the user never sent, which is
      // exactly the kind of content a deletion is meant to take with it.
      await db.delete(agentSendRequests).where(eq(agentSendRequests.userId, userId));
      await db.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.userId, userId));
      await db
        .delete(outboundWebhookDeliveries)
        .where(eq(outboundWebhookDeliveries.userId, userId));
      await db.delete(webhookEndpoints).where(eq(webhookEndpoints.userId, userId));
    },
  },
  activity: {
    exports: [own(usageEvents), own(extensionUsage, "user_id"), own(errorEvents), own(gateEvents), own(planUpgradeEvents), own(pageViews)],
    counts: [usageEvents, extensionUsage, errorEvents, gateEvents, planUpgradeEvents],
    run: async (db, userId) => {
      await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
      // The extension's per-user rate-limit window, keyed on `user_id` as the primary key
      // with no parent to cascade from. A counter, not prose — but it is keyed on the person,
      // and it was the FOURTH user-scoped table found unpurged. Caught the first time
      // `scripts/smoke-purge.ts` ran against a fresh database rather than one that happened
      // to carry a leftover row for its fixture user.
      await db.delete(extensionUsage).where(eq(extensionUsage.userId, userId));
      await db.delete(errorEvents).where(eq(errorEvents.userId, userId));
      await db.delete(gateEvents).where(eq(gateEvents.userId, userId));
      // The account's own upgrade-celebration queue. Nothing outside this user reads it and
      // it carries no operational or financial value, so it is deleted outright rather than
      // anonymised the way `billing_events` is.
      await db.delete(planUpgradeEvents).where(eq(planUpgradeEvents.userId, userId));
      // ANONYMISED, NOT DELETED — same reasoning as `billing_events` below, with a sharper
      // point behind it. `page_views` is an aggregate traffic record: deleting a departing
      // account's rows would retroactively change how many people visited the site last
      // March, which is both wrong and the kind of wrong nobody would ever notice. Nulling
      // `user_id` keeps the count and removes the person — it also makes the privacy page
      // true rather than nearly true, since a view from a signed-in session is the one case
      // where `user_id` was ever set. Folded into `activity` (rather than gated on a full
      // purge like billing) because there is no live external state to protect here: unlike
      // a Stripe subscription, clearing "Usage and diagnostics" alone is a safe time to sever
      // this link too.
      await db.update(pageViews).set({ userId: null }).where(eq(pageViews.userId, userId));
    },
  },
  feedback: {
    exports: [own(feedback), withUrl(own(feedbackScreenshots), "/api/feedback/screenshots/")],
    counts: [feedback, feedbackScreenshots],
    run: async (db, userId) => {
      // Both are personal — one is literally the user's own words — so erasure means
      // erasure, even though the churn reasons are exactly the feedback that leaves with the
      // account. That trade is the right way round; keeping them would mean a user who asked
      // to be deleted still has their opinion on file.
      //
      // Screenshots go first, and by hand rather than through the `on delete cascade`,
      // because the blob objects behind them have no foreign key and nothing else in Orbit
      // will ever come back for them. Best-effort on the blob side: a Blob outage must not be
      // able to block an erasure request, and the row going is the part that is the contract.
      const shots = await db
        .select({ blobUrl: feedbackScreenshots.blobUrl })
        .from(feedbackScreenshots)
        .where(eq(feedbackScreenshots.userId, userId));
      await db.delete(feedbackScreenshots).where(eq(feedbackScreenshots.userId, userId));
      for (const shot of shots) {
        if (!shot.blobUrl) continue;
        try {
          await del(shot.blobUrl);
        } catch {
          // See above. The row is gone either way; an orphaned object is a cost problem, not
          // a privacy one, and it is not worth failing a deletion request over.
        }
      }

      await db.delete(feedback).where(eq(feedback.userId, userId));
    },
  },
  outreach: {
    exports: [
      own(outreachCampaigns),
      joined("outreach_prospects", (userId, limit, offset) => sql`SELECT p.* FROM outreach_prospects p JOIN outreach_campaigns c ON c.id = p.campaign_id WHERE c.user_id = ${userId} ORDER BY p.id LIMIT ${limit} OFFSET ${offset}`),
      joined("outreach_messages", (userId, limit, offset) => sql`SELECT m.* FROM outreach_messages m JOIN outreach_prospects p ON p.id = m.prospect_id JOIN outreach_campaigns c ON c.id = p.campaign_id WHERE c.user_id = ${userId} ORDER BY m.id LIMIT ${limit} OFFSET ${offset}`),
    ],
    counts: [outreachCampaigns],
    run: async (db, userId) => {
      await db.delete(outreachCampaigns).where(eq(outreachCampaigns.userId, userId));
    },
  },
  contacts: {
    exports: [
      contactsSource,
      own(companies),
      own(contactMerges),
      own(contactIdentities),
      own(duplicateSuggestions),
      own(targetCompanies),
      own(contactBriefs, "contact_id"),
      own(contactProfiles),
      own(contactExperiences),
      joined("contact_tags", (userId, limit, offset) => sql`SELECT ct.* FROM contact_tags ct JOIN contacts c ON c.id = ct.contact_id WHERE c.user_id = ${userId} ORDER BY ct.id LIMIT ${limit} OFFSET ${offset}`),
    ],
    // The `implies` list in `DATA_CATEGORY_META` is what stops this step from quietly
    // exceeding a partial request: `interactions`, `reminders`, `contact_embeddings` and
    // `contact_tags` are all `on delete cascade` from `contacts` and go the moment a
    // contact does, ticked or not.
    counts: [contacts, companies, contactMerges],
    run: async (db, userId) => {
      // Read before anything goes: the contact rows and merge snapshots are the only record
      // of which Blob objects are this user's. The objects have no foreign key to cascade.
      const photoRows = await db.execute(sql`
        SELECT profile_image_url AS url FROM contacts WHERE user_id = ${userId} AND profile_image_url LIKE '%.public.blob.vercel-storage.com/avatars/%'
        UNION
        SELECT loser_snapshot->>'profile_image_url' AS url FROM contact_merges WHERE user_id = ${userId} AND loser_snapshot->>'profile_image_url' LIKE '%.public.blob.vercel-storage.com/avatars/%'
      `);
      const photoUrls = rowsOf<{ url: string }>(photoRows).map((r) => r.url);
      // Duplicate-prevention rows. `contact_identities` and `duplicate_suggestions` do
      // cascade from `contacts`, but they are deleted explicitly for the same reason
      // `event_attendees` is: they carry their own `user_id`, so `smoke-purge` requires
      // them, and leaving them to a cascade means a change to that FK silently strips them
      // from account deletion.
      //
      // `contact_merges` is the one that genuinely must be here. It has NO foreign key on
      // either contact id — by design, since the losing contact's row is deleted — so
      // nothing cascades it, and `loser_snapshot` holds a whole archived contact: every
      // field of a person the user knew, surviving the deletion of the contact it came from.
      await db.delete(contactIdentities).where(eq(contactIdentities.userId, userId));
      await db.delete(duplicateSuggestions).where(eq(duplicateSuggestions.userId, userId));
      await db.delete(contactMerges).where(eq(contactMerges.userId, userId));
      // `contact_tags` has no `user_id` of its own, so it is deleted through its contacts.
      // One statement with a subquery, not a query for every contact followed by a delete
      // for each — that shape meant purging a 5,000-contact account took 5,001 round trips.
      await db.delete(contactTags).where(
        inArray(
          contactTags.contactId,
          db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, userId))
        )
      );
      await db.delete(contacts).where(eq(contacts.userId, userId));
      // Cascades from `companies`, and deleted explicitly for the same reason as the
      // duplicate-prevention rows above — it carries its own `user_id`. It's also a
      // statement of intent — where this person wants to work — which is not something to
      // leave behind.
      await db.delete(targetCompanies).where(eq(targetCompanies.userId, userId));
      await db.delete(companies).where(eq(companies.userId, userId));
      // After the rows: a Blob outage leaves orphaned objects, never undeleted people.
      await deleteAvatarBlobs(photoUrls);
    },
  },
  tags: {
    exports: [own(tags)],
    counts: [tags],
    run: async (db, userId) => {
      await db.delete(tags).where(eq(tags.userId, userId));
    },
  },
  preferences: {
    exports: [own(userSettings)],
    counts: [],
    run: async () => {
      // Handled by `purgeUserSettings` at the end of `purgeUserData`, not here: what survives
      // depends on `keepSettings`, which is a property of the caller rather than of the
      // category. Kept in the map so `Record<DataCategory, CategoryStep>` still forces
      // every category to be accounted for here.
    },
  },
};

export function exportSourcesFor(category: DataCategory): readonly ExportSource[] {
  return STEPS[category].exports;
}

export function countedTableNames(category: DataCategory): string[] {
  return STEPS[category].counts.map(getTableName);
}

/**
 * Everything on `user_settings` that is NOT the user's own content, and so survives a
 * delete. The reasoning is that "delete all data" means "delete the data I put in," not
 * "erase the account":
 *   - the BYO provider keys (`*_api_key_encrypted` for Gemini/OpenAI/Anthropic/Apollo/Resend/
 *     Twilio) plus `aiProvider`/`aiModel`, since a key without the selection that uses
 *     it is inert — these are credentials for third-party services the user pays for
 *     directly, not Orbit data about them, unlike the Gmail/Outlook OAuth tokens the
 *     `connections` step purges
 *   - `theme` and `desktopNotificationsEnabled`, cosmetic/device preferences rather than
 *     content
 *   - the Clerk identity mirror (`email`, `firstName`, `lastName`, `profileImageUrl`) and
 *     `createdAt` — account metadata, not something the user authored
 *   - billing/subscription fields — deleting these would silently disconnect a live
 *     subscription from Stripe or reverse a comp with no record of why
 *   - `suspendedAt`/`suspendedReason`/`suspendedBy` — an operator-set flag; a user's own
 *     "delete data" action must not be a backdoor out of a suspension
 *   - signup attribution and `lastActiveAt` — operational metadata about the account, not
 *     user-entered content
 * Everything else on the row — onboarding/wizard state, `desktopNotifiedIds`, `socialLinks`,
 * the calendar feed token and its timestamps, `recruiterSharing` (back to its default of 0,
 * revoking the opt-in since there is no longer data behind it to share) — genuinely is app
 * state tied to the data being deleted, so the row is deleted and recreated with nothing but
 * the id and the columns below, letting the rest fall back to a fresh row's defaults.
 *
 * ADDING A PER-USER FLAG? It belongs here unless it is content. A flag left off this list is
 * silently revoked by every delete, including a partial one.
 */
const PRESERVED_SETTINGS_COLUMNS = {
  geminiApiKeyEncrypted: true,
  openaiApiKeyEncrypted: true,
  anthropicApiKeyEncrypted: true,
  typesafeApiKeyEncrypted: true,
  apolloApiKeyEncrypted: true,
  resendApiKeyEncrypted: true,
  twilioAccountSidEncrypted: true,
  twilioAuthTokenEncrypted: true,
  twilioFromNumber: true,
  aiProvider: true,
  aiModel: true,
  theme: true,
  desktopNotificationsEnabled: true,
  email: true,
  firstName: true,
  lastName: true,
  profileImageUrl: true,
  signupReferrer: true,
  signupUtmSource: true,
  signupUtmMedium: true,
  signupUtmCampaign: true,
  signupLandingPath: true,
  signupAttributedAt: true,
  compedPlan: true,
  lifetimePurchasedAt: true,
  // A deletion made while a Lifetime payment is still clearing must not strand it: the AI
  // gate reads this to recognise the payment before the webhook lands.
  lifetimeCheckoutSessionId: true,
  lifetimeCheckoutStartedAt: true,
  stripeCustomerId: true,
  subscriptionPlan: true,
  subscriptionStatus: true,
  subscriptionPeriodEnd: true,
  subscriptionEventAt: true,
  compedNote: true,
  compedAt: true,
  compedBy: true,
  suspendedAt: true,
  suspendedReason: true,
  suspendedBy: true,
  createdAt: true,
  lastActiveAt: true,
  termsAcceptedAt: true,
  termsVersion: true,
  timelineBackfillEnabled: true,
} as const;

async function purgeUserSettings(db: Db, userId: string, keepSettings: boolean) {
  const preserved = keepSettings
    ? await db.query.userSettings.findFirst({
        where: eq(userSettings.userId, userId),
        columns: PRESERVED_SETTINGS_COLUMNS,
      })
    : undefined;
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  if (preserved) {
    await db.insert(userSettings).values({ userId, ...preserved });
  }
}

export type PurgeOutcome = { runId: string | null; completed: PurgeStepKey[] };

/** Thrown when a step fails; the run stays `running` for `resumeStrandedPurges`. */
export class PurgeIncompleteError extends Error {
  readonly runId: string;
  readonly completed: PurgeStepKey[];
  readonly pending: PurgeStepKey[];
  constructor(runId: string, completed: PurgeStepKey[], pending: PurgeStepKey[], cause: unknown) {
    super(`Purge ${runId} stopped with ${pending.length} step(s) left`, { cause });
    this.name = "PurgeIncompleteError";
    this.runId = runId;
    this.completed = completed;
    this.pending = pending;
  }
}

/** A run touched more recently than this is assumed to still be in flight. */
export const PURGE_RESUME_AFTER_MS = 10 * 60 * 1000;
const PURGE_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function runPurgeStep(db: Db, userId: string, key: PurgeStepKey, keepSettings: boolean) {
  if (key === "billing") {
    await db.update(billingEvents).set({ userId: null }).where(eq(billingEvents.userId, userId));
    return;
  }
  if (key === "preferences") {
    await purgeUserSettings(db, userId, keepSettings);
    return;
  }
  await STEPS[key].run(db, userId);
}

async function executePurgeRun(db: Db, run: DataPurgeRunRow): Promise<PurgeOutcome> {
  const plan = planPurgeSteps(run.categories, run.fullPurge);
  const done = new Set<string>(run.completedSteps);
  for (const key of plan) {
    if (done.has(key)) continue;
    try {
      await runPurgeStep(db, run.targetUserId, key, run.keepSettings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(dataPurgeRuns)
        .set({ lastError: `${key}: ${message}`.slice(0, 500) })
        .where(eq(dataPurgeRuns.id, run.id));
      throw new PurgeIncompleteError(
        run.id,
        plan.filter((k) => done.has(k)),
        plan.filter((k) => !done.has(k)),
        err
      );
    }
    done.add(key);
    await db
      .update(dataPurgeRuns)
      .set({ completedSteps: plan.filter((k) => done.has(k)) })
      .where(eq(dataPurgeRuns.id, run.id));
  }
  await db
    .update(dataPurgeRuns)
    .set({ status: "done", finishedAt: new Date(), lastError: null })
    .where(eq(dataPurgeRuns.id, run.id));
  return { runId: run.id, completed: plan };
}

/**
 * (keep the existing doc comment here, plus:)
 *
 * RESUMABLE. Every call is recorded in `data_purge_runs` before anything is deleted, and each
 * finished step is written back. A throw leaves the run `running` with its `last_error`, and
 * `resumeStrandedPurges` (the nightly job) re-runs what is left. neon-http has no
 * transactions, so this ledger is what stands in for one.
 */
export async function purgeUserData(
  userId: string,
  opts: { keepSettings?: boolean; only?: readonly DataCategory[] } = {}
): Promise<PurgeOutcome> {
  const keepSettings = opts.keepSettings ?? true;
  const selected = opts.only
    ? expandCategories(opts.only)
    : new Set<DataCategory>(DATA_CATEGORY_IDS);
  if (selected.size === 0) return { runId: null, completed: [] };
  const fullPurge = selected.size === DATA_CATEGORY_IDS.length;
  const db = await getDb();

  const [run] = await db
    .insert(dataPurgeRuns)
    .values({ targetUserId: userId, categories: [...selected], keepSettings, fullPurge })
    .returning();
  return executePurgeRun(db, run);
}

/** The nightly backstop: finish stranded runs, give up on hopeless ones, prune old ones. */
export async function resumeStrandedPurges(opts: { now: Date; limit?: number }) {
  const db = await getDb();
  const stats = { found: 0, finished: 0, stillFailing: 0, gaveUp: 0, pruned: 0 };
  const idleSince = new Date(opts.now.getTime() - PURGE_RESUME_AFTER_MS);
  const runs = await db
    .select()
    .from(dataPurgeRuns)
    .where(and(eq(dataPurgeRuns.status, "running"), lt(dataPurgeRuns.lastAttemptAt, idleSince)))
    .orderBy(asc(dataPurgeRuns.lastAttemptAt))
    .limit(opts.limit ?? 10);
  stats.found = runs.length;

  for (const run of runs) {
    if (run.attempts >= PURGE_MAX_ATTEMPTS) {
      await db.update(dataPurgeRuns).set({ status: "failed" }).where(eq(dataPurgeRuns.id, run.id));
      stats.gaveUp += 1;
      continue;
    }
    const attempts = run.attempts + 1;
    await db
      .update(dataPurgeRuns)
      .set({ attempts, lastAttemptAt: opts.now })
      .where(eq(dataPurgeRuns.id, run.id));
    try {
      await executePurgeRun(db, { ...run, attempts });
      stats.finished += 1;
    } catch {
      stats.stillFailing += 1;
    }
  }

  const pruneBefore = new Date(opts.now.getTime() - PURGE_RUN_RETENTION_MS);
  const pruned = await db
    .delete(dataPurgeRuns)
    .where(and(eq(dataPurgeRuns.status, "done"), lt(dataPurgeRuns.finishedAt, pruneBefore)))
    .returning();
  stats.pruned = pruned.length;
  return stats;
}

/**
 * How many rows each category would delete, so the dialog can say "1,240 contacts" instead
 * of asking someone to guess.
 *
 * One statement with a scalar subquery per table rather than a count per table: this runs on
 * dialog open, and the neon-http driver charges a round trip for every statement.
 */
export async function getDataFootprint(
  userId: string
): Promise<Record<DataCategory, number>> {
  const db = await getDb();
  const tableNames = [
    ...new Set(
      Object.values(STEPS).flatMap((step) => step.counts.map(getTableName))
    ),
  ];

  const result = await db.execute(
    sql`SELECT ${sql.join(
      tableNames.map(
        (name) =>
          sql`(SELECT count(*)::int FROM ${sql.identifier(name)} WHERE user_id = ${userId}) AS ${sql.identifier(name)}`
      ),
      sql`, `
    )}`
  );
  const row = rowsOf<Record<string, number>>(result)[0] ?? {};

  const footprint = {} as Record<DataCategory, number>;
  for (const { id } of DATA_CATEGORY_META) {
    footprint[id] = STEPS[id].counts.reduce(
      (sum, table) => sum + (Number(row[getTableName(table)]) || 0),
      0
    );
  }
  return footprint;
}

/**
 * A purge's result in the shape the settings dialog shows: categories only (the billing step
 * is bookkeeping, not something the user picked), and a stop reported as data rather than a
 * throw, because a thrown server-action error reaches production only as a digest.
 */
export async function deletionOutcome(
  runPurge: () => Promise<PurgeOutcome>
): Promise<{ deleted: DataCategory[]; pending: DataCategory[] }> {
  try {
    const outcome = await runPurge();
    return { deleted: outcome.completed.filter(isDataCategory), pending: [] };
  } catch (err) {
    if (!(err instanceof PurgeIncompleteError)) throw err;
    return {
      deleted: err.completed.filter(isDataCategory),
      pending: err.pending.filter(isDataCategory),
    };
  }
}
