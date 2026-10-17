/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: after you delete a contact, the notifications panel (the bell) keeps listing AI
 * suggestions about them — "Ada joined Globex Labs" — linking to `/contacts/<deleted id>`,
 * which 404s. For suggestion types the periodic rebuild does not own (job-change congrats,
 * job-feed matches, enrichment score bumps) the ghost never goes away on its own.
 *
 * Why: `ai_suggestions.related_contact_ids` is jsonb with no foreign key, so deleting the
 * contact does not cascade to it, and `deleteContactsForUser` (src/lib/contact-delete.ts:76-107)
 * does not clear it either. That is a deliberate choice — stale ids are meant to be filtered
 * on read — and the dashboard (`loadDashboardSuggestions`, src/lib/reminders.ts:826-834, "a
 * suggestion about a contact that no longer exists in this account is dropped") and the chat
 * attention brief (`getAttentionBrief`, src/lib/chat-attention.ts:196-199) both do filter.
 * `loadNotificationPanel` (src/lib/notification-panel.ts:83-90 and 247-262) does not: it maps
 * every pending suggestion straight to a panel item.
 *
 * The other stale-id columns delete leaves behind were checked and are NOT surfaced:
 * memory_chunks.contact_ids (the chat lane drops unknown ids, src/lib/chat-lanes.ts:229-235),
 * email_sends.contact_ids (readers are keyed by a contact that no longer resolves; the send
 * itself fails its interaction log with ContactNotFoundError), capture_jobs.seed_contact_id and
 * import_job_rows.contact_id (copied / re-deleted by id, never rendered).
 *
 * Trigger path: Orbit detects a job change for Ada and writes a `job_change_congrats`
 * suggestion (src/lib/job-changes.ts:416); the user deletes Ada from her contact page
 * (`deleteContact`, src/actions/contacts.ts:817); the bell still says "Ada joined Globex Labs".
 *
 * Severity: medium — a deleted person's name keeps appearing in the user's notifications with
 * a dead link, contradicting the delete; no data crosses accounts.
 *
 * Fix: either clear suggestions naming the deleted ids in `deleteContactsForUser`, or apply the
 * dashboard's "contact still exists" filter in `loadNotificationPanel`. This script then exits
 * 0 and should be promoted to the pglite tier.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-bug-contact-delete-ghost-suggestion.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { aiSuggestions } from "../src/db/schema";
import { getAttentionBrief } from "../src/lib/chat-attention";
import { deleteContactForUser } from "../src/lib/contact-delete";
import { JOB_CHANGE_SUGGESTION_TYPE } from "../src/lib/job-changes";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import { loadDashboardSuggestions } from "../src/lib/reminders";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("delete-ghost");

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  try {
    const doomed = await insertContact(db, USER, 0); // Ada Lovelace
    const kept = await insertContact(db, USER, 1); // Grace Hopper
    await db.insert(aiSuggestions).values([
      {
        userId: USER,
        suggestionType: JOB_CHANGE_SUGGESTION_TYPE,
        title: "Ada joined Globex Labs",
        description: "Ada started at Globex Labs — a good moment to congratulate them.",
        relatedContactIds: [doomed.id],
        confidenceScore: 70,
        status: "pending",
      },
      {
        userId: USER,
        suggestionType: JOB_CHANGE_SUGGESTION_TYPE,
        title: "Grace joined Initech",
        description: "Grace started at Initech — a good moment to congratulate them.",
        relatedContactIds: [kept.id],
        confidenceScore: 70,
        status: "pending",
      },
    ]);

    const now = new Date();
    const before = await loadNotificationPanel(USER, now, { withAlerts: false });
    t.check(
      "setup: before the delete, the panel lists the suggestion about Ada",
      before.items.some((i) => i.contactId === doomed.id)
    );

    const { deleted } = await deleteContactForUser(USER, doomed.id);
    t.check("setup: the contact is deleted", deleted);

    // The filtered readers: these are the behaviour the panel should match.
    const dashboard = await loadDashboardSuggestions(USER, now);
    const dashboardIds = dashboard.rows.map((r) => r.relatedContactIds?.[0]);
    t.check("the dashboard drops the suggestion about the deleted contact", !dashboardIds.includes(doomed.id), JSON.stringify(dashboardIds));
    t.check("the dashboard still shows the suggestion about a live contact", dashboardIds.includes(kept.id));

    const brief = await getAttentionBrief(USER);
    t.check("the chat attention brief drops the deleted contact", !brief.suggestions.some((s) => s.id === doomed.id));
    t.check("the chat attention brief keeps the live contact", brief.suggestions.some((s) => s.id === kept.id));

    const after = await loadNotificationPanel(USER, now, { withAlerts: false });
    const ghost = after.items.find((i) => i.contactId === doomed.id || i.url === `/contacts/${doomed.id}`);
    t.knownBug(
      "BUG: the notifications panel still lists an AI suggestion about a deleted contact",
      !ghost,
      ghost ? `"${ghost.title}" -> ${ghost.url}` : ""
    );
    t.check("the panel still lists the live contact's suggestion", after.items.some((i) => i.contactId === kept.id));
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("contact delete ghost suggestion (known bug)");
});
