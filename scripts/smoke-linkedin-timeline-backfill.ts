/**
 * Timeline-event derivation is what turns an imported LinkedIn thread into something a user
 * can actually read on a contact's timeline. It used to run inline in the per-conversation
 * importer; moving LinkedIn messages onto the resumable engine dropped it entirely. This
 * suite covers the deferred runner that restores it — and, more importantly, the three
 * properties that make deferring it safe: the flagless "pending" predicate really does
 * shrink as work is done, it never re-derives events for threads the pre-engine importer
 * already processed, and it cannot spin forever on a contact that yields nothing.
 *
 * Run: npx tsx scripts/smoke-linkedin-timeline-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

// Env reads in auth.ts and db/index.ts are lazy (inside functions), so setting these
// after dotenv but before the src/ imports below still lands before anything reads them.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-li-timeline";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-li-timeline";
// This suite must run against the local per-worktree PGlite file, never a remote
// database: it hard-deletes a user's contacts, and .env.local gaining a DATABASE_URL
// (one `vercel env pull` away) would point that at shared data.
delete process.env.DATABASE_URL;

import { and, asc, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import type { extractLinkedInTimelineEvents } from "../src/lib/linkedin-timeline-events";
import {
  pendingTimelineContactCount,
  runLinkedInTimelineBackfill,
  usersWithPendingTimelineEvents,
} from "../src/lib/linkedin-timeline-backfill";
import { ensureUserSettings } from "../src/lib/user-settings";

const DRAIN_USER = "smoke-li-timeline-drain-user";
const SKIP_USER = "smoke-li-timeline-skip-user";
const LEGACY_USER = "smoke-li-timeline-legacy-user";
const REAL_USER = "smoke-li-timeline-real-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset(userId: string) {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(interactions).where(eq(interactions.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await ensureUserSettings(userId);
}

/** Seed one contact plus its LinkedIn message rows, shaped exactly as the adapter writes them. */
async function seedThread(
  userId: string,
  fullName: string,
  messages: { body: string; sentAt: Date | null }[]
) {
  const db = await getDb();
  const [contact] = await db
    .insert(contacts)
    .values({ userId, fullName, source: "linkedin_messages" })
    .returning();

  if (messages.length > 0) {
    await db.insert(interactions).values(
      messages.map((m, i) => ({
        userId,
        contactId: contact.id,
        interactionType: "linkedin_message",
        interactionDate: m.sentAt ?? new Date(),
        source: "linkedin_messages",
        // Same shape `linkedInMessageExternalId` mints — the conversation id is in there,
        // which is why the runner needs no `conversation_id` column to stay unique.
        externalId: `li-msg:conv-${fullName}:${(m.sentAt ?? new Date()).toISOString()}:${i}`,
        rawNotes: m.body,
        aiSummary: m.body.slice(0, 240),
        topics: [],
      }))
    );
  }
  return contact.id;
}

async function eventRows(userId: string, contactId?: string) {
  const db = await getDb();
  return db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      like(interactions.externalId, "li-event:%"),
      ...(contactId ? [eq(interactions.contactId, contactId)] : [])
    ),
    orderBy: [asc(interactions.interactionDate)],
  });
}

/**
 * Deterministic stand-in for the extractor, injected through the runner's `extract` seam.
 *
 * Records what it was handed so the ordering property below can be asserted directly: the
 * runner must pass messages oldest-first, because the first event the real extractor emits
 * is the *initial* reach-out and a newest-first read would stamp the wrong message as it.
 */
const seen: { scopeId: string; contents: string[] }[] = [];
const stubExtract: typeof extractLinkedInTimelineEvents = async (
  _userId,
  scopeId,
  messages
) => {
  seen.push({ scopeId, contents: messages.map((m) => m.content) });
  return [
    {
      interactionType: "reach_out",
      interactionDate: messages[0]?.parsedDate ?? new Date(),
      summary: `Initial LinkedIn reach-out: ${messages[0]?.content ?? ""}`,
      rawNotes: messages[0]?.content ?? "",
      externalId: `li-event:${scopeId}:reach_out:stub`,
    },
    {
      interactionType: "meeting",
      interactionDate: messages[messages.length - 1]?.parsedDate ?? new Date(),
      summary: "Coffee proposed",
      rawNotes: messages[messages.length - 1]?.content ?? "",
      externalId: `li-event:${scopeId}:meeting:stub`,
    },
  ];
};

/**
 * Section 1: the drain path, and the flagless pending predicate that drives it.
 *
 * The fixture deliberately mixes three shapes that the predicate must tell apart, because
 * getting any of them wrong is silent: a real thread (claimable), a contact with no LinkedIn
 * messages at all (never claimable — this is every non-LinkedIn contact in the network, so a
 * predicate that caught them would spend one AI call per contact on people with no thread to
 * read), and a contact whose messages are all whitespace (never claimable — the real
 * extractor returns `[]` for those, so claiming one would leave it pending, re-claim it next
 * iteration, and spin the runner on an unbounded loop of empty AI calls).
 */
async function testDrainAndPendingPredicate() {
  await reset(DRAIN_USER);
  seen.length = 0;

  const day = (n: number) => new Date(Date.UTC(2024, 0, n));

  const threadId = await seedThread(DRAIN_USER, "Ada Lovelace", [
    { body: "Hi Ada, loved your talk on analytical engines.", sentAt: day(3) },
    { body: "Thanks! Want to grab coffee next Tuesday?", sentAt: day(9) },
  ]);
  const noMessagesId = await seedThread(DRAIN_USER, "Grace Hopper", []);
  const blankId = await seedThread(DRAIN_USER, "Blank Thread", [
    { body: "   ", sentAt: day(4) },
    { body: "", sentAt: day(5) },
  ]);

  check(
    "only the contact with real message text is pending",
    (await pendingTimelineContactCount(DRAIN_USER)) === 1,
    `count ${await pendingTimelineContactCount(DRAIN_USER)}`
  );

  const first = await runLinkedInTimelineBackfill(DRAIN_USER, stubExtract);
  check(
    "first pass processes exactly the pending contact",
    first.contactsProcessed === 1 && first.eventsCreated === 2 && first.remaining === 0,
    JSON.stringify(first)
  );

  // Keyed by contact id, not conversation id — the namespace difference is what section 3
  // relies on to leave pre-engine threads alone.
  check(
    "events are scoped to the contact id",
    seen.length === 1 && seen[0].scopeId === threadId,
    JSON.stringify(seen.map((s) => s.scopeId))
  );
  check(
    "messages reach the extractor oldest-first",
    seen[0].contents[0].startsWith("Hi Ada"),
    JSON.stringify(seen[0].contents)
  );

  const rows = await eventRows(DRAIN_USER, threadId);
  check("both events were written", rows.length === 2, `rows ${rows.length}`);
  check(
    "event rows carry the derived type, date and summary",
    rows[0].interactionType === "reach_out" &&
      rows[0].interactionDate.toISOString() === day(3).toISOString() &&
      rows[1].interactionType === "meeting" &&
      rows[1].aiSummary === "Coffee proposed",
    JSON.stringify(rows.map((r) => [r.interactionType, r.aiSummary]))
  );
  check(
    "the contact with no messages was never touched",
    (await eventRows(DRAIN_USER, noMessagesId)).length === 0
  );
  check(
    "the all-whitespace thread was never claimed",
    (await eventRows(DRAIN_USER, blankId)).length === 0 && seen.length === 1
  );

  // Idempotence, and the property that makes the route's re-kick loop terminate: a second
  // pass must find nothing pending. If the claim and the count could ever disagree, this is
  // where it shows up as an unbounded loop rather than as a wrong number.
  const second = await runLinkedInTimelineBackfill(DRAIN_USER, stubExtract);
  check(
    "second pass derives nothing and reports nothing remaining",
    second.contactsProcessed === 0 && second.eventsCreated === 0 && second.remaining === 0,
    JSON.stringify(second)
  );
  check(
    "second pass created no duplicate rows",
    (await eventRows(DRAIN_USER, threadId)).length === 2
  );
}

/**
 * Section 2: the cron backstop's input, and the time-budget seam.
 *
 * `usersWithPendingTimelineEvents` and `pendingTimelineContactCount` are two readings of
 * one SQL fragment on purpose — if they could drift, the daily sweep would kick users the
 * runner then finds nothing to do for, forever.
 */
async function testSweepAndBudget() {
  await reset(SKIP_USER);
  seen.length = 0;

  await seedThread(SKIP_USER, "Alan Turing", [
    { body: "Following up on the paper we discussed.", sentAt: new Date(Date.UTC(2024, 2, 1)) },
  ]);

  const pendingUsers = await usersWithPendingTimelineEvents(50);
  check(
    "the sweep lists a user with pending work",
    pendingUsers.includes(SKIP_USER),
    JSON.stringify(pendingUsers)
  );

  // A zero budget must do no work at all rather than one "free" iteration — the cron hands
  // this runner whatever is left of its own slice, and a runner that ignores an exhausted
  // budget is how a 300s function gets killed with its ledger row still marked running.
  const starved = await runLinkedInTimelineBackfill(SKIP_USER, stubExtract, 0);
  check(
    "an exhausted budget does no work but still reports what is left",
    starved.contactsProcessed === 0 && starved.eventsCreated === 0 && starved.remaining === 1,
    JSON.stringify(starved)
  );
  check("no extractor call was made under a zero budget", seen.length === 0);

  await runLinkedInTimelineBackfill(SKIP_USER, stubExtract);
  check(
    "the sweep drops the user once the work is drained",
    !(await usersWithPendingTimelineEvents(50)).includes(SKIP_USER)
  );
}

/**
 * Section 3: threads the pre-engine importer already processed are left alone.
 *
 * Those rows are keyed `li-event:<conversationId>:…` and this runner mints
 * `li-event:<contactId>:…`, so nothing dedupes them against each other — the *predicate* is
 * what has to exclude them, via `external_id LIKE 'li-event:%'`. Without this, every user
 * who imported messages before the engine migration gets a second, differently-keyed set of
 * events for every thread they already have, at one AI call each.
 */
async function testLegacyEventsAreNotRederived() {
  await reset(LEGACY_USER);
  seen.length = 0;

  const db = await getDb();
  const contactId = await seedThread(LEGACY_USER, "Legacy Thread", [
    { body: "Original outreach from the old importer era.", sentAt: new Date(Date.UTC(2023, 5, 1)) },
  ]);

  check("the legacy thread starts out pending", (await pendingTimelineContactCount(LEGACY_USER)) === 1);

  await db.insert(interactions).values({
    userId: LEGACY_USER,
    contactId,
    interactionType: "reach_out",
    interactionDate: new Date(Date.UTC(2023, 5, 1)),
    // The pre-engine source string, which is also why the pending predicate matches on
    // `interaction_type` alone rather than on `source`.
    source: "linkedin_messages_import",
    externalId: "li-event:conv-legacy-42:reach_out:abc123",
    rawNotes: "Original outreach from the old importer era.",
    aiSummary: "Initial LinkedIn reach-out",
    topics: [],
  });

  check(
    "a contact carrying old-format events is no longer pending",
    (await pendingTimelineContactCount(LEGACY_USER)) === 0
  );

  const res = await runLinkedInTimelineBackfill(LEGACY_USER, stubExtract);
  check(
    "the runner re-derives nothing for it",
    res.contactsProcessed === 0 && res.eventsCreated === 0 && seen.length === 0,
    JSON.stringify(res)
  );
  check(
    "its single legacy event row is untouched",
    (await eventRows(LEGACY_USER)).length === 1
  );
}

/**
 * Section 4: the real extractor, through the default seam.
 *
 * No stub — this runs `extractLinkedInTimelineEvents` itself. With no AI key configured
 * (the normal local case) `completeJson` rejects and the extractor falls back to its
 * heuristic pass; with a key it calls the model. Both paths emit the rule-based reach-out
 * unconditionally, so that is what this asserts. Anything model-dependent is deliberately
 * left out rather than made flaky — the point of this section is that the default argument
 * is wired correctly and the runner drains for real, not what the model says.
 */
async function testRealExtractorEndToEnd() {
  await reset(REAL_USER);

  const contactId = await seedThread(REAL_USER, "Katherine Johnson", [
    { body: "Hi Katherine — following up after the conference.", sentAt: new Date(Date.UTC(2024, 4, 2)) },
    { body: "Could we schedule a call next week to talk it through?", sentAt: new Date(Date.UTC(2024, 4, 6)) },
  ]);

  const res = await runLinkedInTimelineBackfill(REAL_USER);
  check(
    "the real extractor drains the contact",
    res.contactsProcessed === 1 && res.eventsCreated >= 1 && res.remaining === 0,
    JSON.stringify(res)
  );

  const rows = await eventRows(REAL_USER, contactId);
  const reachOut = rows.find((r) => r.interactionType === "reach_out");
  check(
    "the rule-based initial reach-out is present and keyed by contact id",
    !!reachOut && reachOut.externalId!.startsWith(`li-event:${contactId}:reach_out:`),
    JSON.stringify(rows.map((r) => [r.interactionType, r.externalId]))
  );
  check(
    "the reach-out is stamped with the oldest message's date, not the newest",
    reachOut?.interactionDate.toISOString() === new Date(Date.UTC(2024, 4, 2)).toISOString(),
    String(reachOut?.interactionDate)
  );
  check(
    "derived events are written under the engine's source string",
    rows.every((r) => r.source === "linkedin_messages"),
    JSON.stringify(rows.map((r) => r.source))
  );

  const second = await runLinkedInTimelineBackfill(REAL_USER);
  check(
    "a second real pass is a no-op",
    second.contactsProcessed === 0 && second.eventsCreated === 0,
    JSON.stringify(second)
  );
}

async function cleanup() {
  const db = await getDb();
  for (const userId of [DRAIN_USER, SKIP_USER, LEGACY_USER, REAL_USER]) {
    await db.delete(contacts).where(eq(contacts.userId, userId));
    await db.delete(interactions).where(eq(interactions.userId, userId));
    await db.delete(userSettings).where(eq(userSettings.userId, userId));
  }
}

async function main() {
  console.log("LinkedIn timeline-event backfill (pglite)...");
  check("running with Clerk configured", isClerkConfigured() === true);
  check("running outside demo mode", isDemoMode() === false);

  console.log("\n-- drain, and the flagless pending predicate --");
  await testDrainAndPendingPredicate();

  console.log("\n-- cron sweep input and the time budget --");
  await testSweepAndBudget();

  console.log("\n-- pre-engine threads are not re-derived --");
  await testLegacyEventsAreNotRederived();

  console.log("\n-- the real extractor through the default seam --");
  await testRealExtractorEndToEnd();

  await cleanup();
  console.log("\nTimeline backfill checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
