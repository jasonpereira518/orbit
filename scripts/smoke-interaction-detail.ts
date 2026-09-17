/**
 * What the timeline's detail sheet is handed for one interaction, and specifically the
 * meeting block behind it.
 *
 * THE GAP THIS CLOSES. A recorded meeting produces one interaction per participant, each
 * summarised for THAT person. What the meeting itself was — its title, what it was about,
 * what was decided — belongs to the call and to no single person, so it only ever lived in
 * `note_batches.result.meeting` and never left the capture results page. Opening a timeline
 * entry from a meeting showed you your half of it with no way to see the whole.
 *
 * The property worth pinning here is the boring one: `interactions.note_batch_id` is a plain
 * column with NO foreign key, so it is not self-evidently the caller's batch. The lookup is
 * scoped by user, and the case below proves it.
 *
 * Run: npx tsx scripts/smoke-interaction-detail.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, noteBatches } from "../src/db/schema";
import { emptyNoteBatchResult } from "../src/lib/note-batches";
import { ensureUserSettings } from "../src/lib/user-settings";
import type { NoteBatchMeeting } from "../src/db/schema";

/**
 * With no Clerk keys and NODE_ENV=development, `requireUserId()` resolves to demo mode's
 * `demo-user` — the identity everything below is seeded under. Same trick, and the same
 * reason, as `scripts/smoke-follow-up-actions.ts`.
 */
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

const USER = "demo-user";
const STRANGER = "smoke-interaction-detail-stranger";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const MEETING: NoteBatchMeeting = {
  sessionId: "session-1",
  title: "Infra sync with Ada",
  summary: "Walked through the migration plan and agreed who owns the cutover.",
  keyPoints: ["Migration is two phases"],
  decisions: ["Ada owns the cutover", "We slip the read path to Q2"],
  actionItems: [{ text: "Draft the runbook", owner: "Ada" }],
  blockers: [],
  openQuestions: [],
  durationMs: 45 * 60_000,
  startedAtIso: "2026-09-01T15:00:00.000Z",
};

async function seedBatch(userId: string, meeting: NoteBatchMeeting | null) {
  const db = await getDb();
  const [batch] = await db
    .insert(noteBatches)
    .values({
      userId,
      sourceHash: `hash-${userId}-${meeting ? "meeting" : "plain"}`,
      sourceText: "Met Ada about the migration.",
      anchorDate: new Date("2026-09-01T12:00:00Z"),
      result: meeting ? { ...emptyNoteBatchResult(), meeting } : emptyNoteBatchResult(),
    })
    .returning();
  return batch!;
}

async function seedInteraction(contactId: string, noteBatchId: string | null) {
  const db = await getDb();
  const [row] = await db
    .insert(interactions)
    .values({
      userId: USER,
      contactId,
      interactionType: "meeting",
      interactionDate: new Date("2026-09-01T15:00:00Z"),
      aiSummary: "Ada walked me through the migration.",
      rawNotes: "Met Ada about the migration.",
      noteBatchId,
    })
    .returning();
  return row!;
}

async function reset() {
  const db = await getDb();
  for (const user of [USER, STRANGER]) {
    // Cascades interactions, mentions and action items.
    await db.delete(contacts).where(eq(contacts.userId, user));
    await db.delete(noteBatches).where(eq(noteBatches.userId, user));
  }
  await ensureUserSettings(USER);
}

async function main() {
  await reset();
  const db = await getDb();
  // Imported AFTER the env is rewritten above: the auth module reads the Clerk keys when it
  // is first loaded, so importing at the top would capture them before they are deleted.
  const { getInteractionDetail } = await import("../src/actions/contacts");

  const [ada] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Ada Lovelace" })
    .returning();

  console.log("\na meeting's own half of the story");
  {
    const batch = await seedBatch(USER, MEETING);
    const row = await seedInteraction(ada!.id, batch.id);
    const detail = await getInteractionDetail(row.id);

    check("the per-person summary is untouched", detail.aiSummary === "Ada walked me through the migration.");
    check("the meeting's title comes through", detail.meeting?.title === MEETING.title, detail.meeting?.title ?? "null");
    check("  and its summary", detail.meeting?.summary === MEETING.summary);
    check("  and what was decided", detail.meeting?.decisions.join(" | ") === "Ada owns the cutover | We slip the read path to Q2", JSON.stringify(detail.meeting?.decisions));
    check("the batch id is carried for the link back", detail.batchId === batch.id);
  }

  console.log("\na capture that was not a meeting");
  {
    const batch = await seedBatch(USER, null);
    const row = await seedInteraction(ada!.id, batch.id);
    const detail = await getInteractionDetail(row.id);
    // Still linkable — the results page holds the other people and the reminders — but
    // there is no call-level digest to show, and inventing one would be a lie.
    check("there is no meeting block", detail.meeting === null);
    check("  but the capture is still reachable", detail.batchId === batch.id);
  }

  console.log("\nan interaction that came from nowhere in particular");
  {
    const row = await seedInteraction(ada!.id, null);
    const detail = await getInteractionDetail(row.id);
    check("no batch, no meeting, no crash", detail.batchId === null && detail.meeting === null);
  }

  console.log("\nthe batch lookup is scoped by user");
  {
    // `interactions.note_batch_id` has no foreign key, so a row can point anywhere. Nothing
    // in the product writes this, which is exactly why it is worth pinning: the day
    // something does, it must not become a way to read another account's meeting.
    const theirs = await seedBatch(STRANGER, {
      ...MEETING,
      title: "Somebody else's private meeting",
      summary: "Confidential.",
    });
    const row = await seedInteraction(ada!.id, theirs.id);
    const detail = await getInteractionDetail(row.id);
    check("another account's batch yields no meeting", detail.meeting === null, JSON.stringify(detail.meeting));
    // The id itself is the interaction's own column and is what it is; the link 404s for
    // this user. What must never happen is the CONTENT crossing over, and it does not.
    check("  and none of its text", JSON.stringify(detail).includes("Confidential.") === false);
  }

  await reset();
  console.log("\nsmoke-interaction-detail: all checks passed");
  // PGlite keeps the event loop alive; without this the suite hangs here.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
