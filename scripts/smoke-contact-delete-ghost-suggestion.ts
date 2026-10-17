/**
 * After a contact is deleted, the notifications panel (the bell) no longer lists AI
 * suggestions about them.
 *
 * `ai_suggestions.related_contact_ids` is jsonb with no foreign key, so deleting a contact
 * leaves its suggestions behind — deliberately: stale ids are filtered on read. The dashboard
 * (`loadDashboardSuggestions`, src/lib/reminders.ts) and the chat attention brief
 * (`getAttentionBrief`, src/lib/chat-attention.ts) always filtered; `loadNotificationPanel`
 * (src/lib/notification-panel.ts) did not, so the bell kept saying "Ada joined Globex Labs"
 * with a link to a 404, forever for suggestion types no rebuild owns (job-change congrats,
 * job-feed matches). The panel's query now applies the same "contact still exists" filter in
 * SQL. This pins the panel against the other two readers.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-contact-delete-ghost-suggestion.ts
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
    t.check(
      "the notifications panel drops the AI suggestion about the deleted contact",
      !ghost,
      ghost ? `"${ghost.title}" -> ${ghost.url}` : ""
    );
    t.check("the panel still lists the live contact's suggestion", after.items.some((i) => i.contactId === kept.id));
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("contact delete ghost suggestion");
});
