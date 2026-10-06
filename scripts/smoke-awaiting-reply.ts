/**
 * Guards "you wrote nine days ago and nobody has answered".
 *
 * The landing page says Orbit "tracks who replied — and nudges you about who you still owe a
 * follow-up". Half of that was true. `replied_at` existed only on `outreach_messages`, the
 * paid campaign path; the personal follow-up loop — a job seeker emailing twenty people in a
 * week — had no notion of waiting for an answer, so a message sent and ignored looked exactly
 * like a message sent and answered.
 *
 * Two things had to be true, and the checks below pin both:
 *
 *   1. An outbound touch records that it was outbound, on EVERY channel. It used to be
 *      recorded for `linkedin_message` only, so the email follow-ups this audience actually
 *      sends left no trace of who sent them.
 *   2. "Awaiting a reply" is decided from what Orbit can actually know — that the most recent
 *      recorded row is one the user sent — never from a guess about what the other person
 *      did. An unknown direction is not an outbound one.
 *
 * Run: npx tsx scripts/smoke-awaiting-reply.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-awaiting-reply";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-awaiting-reply";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiSuggestions, contacts, interactions, userSettings } from "../src/db/schema";
import { recalibrateCloseness } from "../src/lib/closeness-cohort";
import { refreshOutreachSuggestions } from "../src/lib/reminders";
import { ensureUserSettings } from "../src/lib/user-settings";

import {
  AWAITING_REPLY_MAX_DAYS,
  AWAITING_REPLY_MIN_DAYS,
  awaitingReplies,
  awaitingReplyDescription,
  type LastTouch,
} from "../src/lib/awaiting-reply";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const NOW = new Date("2026-09-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const touch = (over: Partial<LastTouch> = {}): LastTouch => ({
  contactId: "c1",
  direction: "out",
  interactionDate: daysAgo(9),
  ...over,
});

const USER = "smoke-awaiting-reply-user";

function pureChecks() {
  section("An unanswered message is surfaced");

  const waiting = awaitingReplies([touch()], NOW);
  check("nine days with nothing back is surfaced", waiting.length === 1);
  check("and the wait is counted in whole days", waiting[0]?.daysWaiting === 9, `got ${waiting[0]?.daysWaiting}`);
  check(
    "the copy claims only what Orbit knows",
    awaitingReplyDescription(9) === "You reached out 9 days ago — nothing back yet",
    `got ${JSON.stringify(awaitingReplyDescription(9))} — never "they have not replied", which Orbit cannot know`
  );
  check("one day is singular", awaitingReplyDescription(1).includes("1 day ago"));

  section("An unknown direction is NOT an outbound one");

  // This is the check that stops half a LinkedIn import appearing in a queue claiming the
  // user is waiting on replies they never asked for. Most interactions in this app carry no
  // direction at all — a pasted note, an imported connection.
  check(
    "a null direction is ignored",
    awaitingReplies([touch({ direction: null })], NOW).length === 0,
    "reading 'unknown' as 'I sent it' would invent a wait that never happened"
  );
  check(
    "an inbound last touch is ignored",
    awaitingReplies([touch({ direction: "in" })], NOW).length === 0
  );

  section("The window");

  check(
    "too recent to nag",
    awaitingReplies([touch({ interactionDate: daysAgo(AWAITING_REPLY_MIN_DAYS - 1) })], NOW).length === 0
  );
  check(
    "the first day of the window counts",
    awaitingReplies([touch({ interactionDate: daysAgo(AWAITING_REPLY_MIN_DAYS) })], NOW).length === 1
  );
  check(
    "the last day of the window counts",
    awaitingReplies([touch({ interactionDate: daysAgo(AWAITING_REPLY_MAX_DAYS) })], NOW).length === 1
  );
  check(
    "past the window, dormancy takes over instead",
    awaitingReplies([touch({ interactionDate: daysAgo(AWAITING_REPLY_MAX_DAYS + 1) })], NOW).length === 0,
    "dormant_high_value fires at 30 days and says something more useful"
  );
  check(
    "the window ends where dormancy begins",
    AWAITING_REPLY_MAX_DAYS === 30 && AWAITING_REPLY_MIN_DAYS >= 5,
    `${AWAITING_REPLY_MIN_DAYS}..${AWAITING_REPLY_MAX_DAYS}`
  );

  section("Anything recorded since clears it, with no second state to keep in sync");

  // The whole design: this is not a flag that has to be unset. It is a question asked of the
  // most recent row, so a reply, a call, or a note all clear it by existing.
  check(
    "a later inbound row clears the wait",
    awaitingReplies([touch({ direction: "in", interactionDate: daysAgo(1) })], NOW).length === 0
  );
  check(
    "so does a later undirected note",
    awaitingReplies([touch({ direction: null, interactionDate: daysAgo(1) })], NOW).length === 0
  );

  section("Ordering and bad data");

  const many = awaitingReplies(
    [
      touch({ contactId: "recent", interactionDate: daysAgo(6) }),
      touch({ contactId: "oldest", interactionDate: daysAgo(28) }),
      touch({ contactId: "middle", interactionDate: daysAgo(14) }),
    ],
    NOW
  );
  check(
    "longest wait first",
    many.map((w) => w.contactId).join(",") === "oldest,middle,recent",
    `got ${many.map((w) => w.contactId).join(",")}`
  );
  check("a missing date is skipped, not counted as zero", awaitingReplies([touch({ interactionDate: null })], NOW).length === 0);
  check("an unparseable date is skipped", awaitingReplies([touch({ interactionDate: "not-a-date" })], NOW).length === 0);
  check("a future date is skipped", awaitingReplies([touch({ interactionDate: new Date(NOW.getTime() + 86_400_000) })], NOW).length === 0);
  check("no touches, no suggestions", awaitingReplies([], NOW).length === 0);
}

/**
 * The predicate being right is worth nothing if the dashboard never calls it. This runs the
 * real entry point — the one the dashboard awaits — and reads back what it wrote.
 */
async function dbChecks() {
  const db = await getDb();
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const realDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  async function person(fullName: string, over: Record<string, unknown> = {}) {
    const [c] = await db
      .insert(contacts)
      .values({ userId: USER, fullName, lastInteractionAt: realDaysAgo(9), ...over })
      .returning();
    return c;
  }
  async function touched(
    contactId: string,
    rows: { type: string; direction: "in" | "out" | null; days: number }[]
  ) {
    for (const r of rows) {
      await db.insert(interactions).values({
        userId: USER,
        contactId,
        interactionType: r.type as never,
        direction: r.direction,
        interactionDate: realDaysAgo(r.days),
        rawNotes: "x",
      });
    }
  }

  // The case the whole feature exists for: an EMAIL follow-up, the channel this audience
  // actually uses, which before this change recorded no direction at all.
  const waiting = await person("Waiting Wendy");
  await touched(waiting.id, [{ type: "email", direction: "out", days: 9 }]);

  // They wrote back. Nothing should nag about this one.
  const answered = await person("Answered Anna");
  await touched(answered.id, [
    { type: "email", direction: "out", days: 9 },
    { type: "email", direction: "in", days: 2 },
  ]);

  // Direction unknown — an import, a pasted note. Not a wait.
  const unknown = await person("Unknown Uma");
  await touched(unknown.id, [{ type: "note", direction: null, days: 9 }]);

  // Already has a follow-up booked: `isDiscoveryEligible` must suppress it, or the user gets
  // told to chase somebody who is already on their calendar.
  const scheduled = await person("Scheduled Sam", { nextFollowUpAt: realDaysAgo(-3) });
  await touched(scheduled.id, [{ type: "email", direction: "out", days: 9 }]);

  // Explicitly pinned off the constellation — the user said don't show me this person.
  const hidden = await person("Hidden Hank", { constellationPin: "out" });
  await touched(hidden.id, [{ type: "email", direction: "out", days: 9 }]);

  await refreshOutreachSuggestions(USER);

  const rows = await db.query.aiSuggestions.findMany({
    where: eq(aiSuggestions.userId, USER),
  });
  const awaiting = rows.filter((r) => r.suggestionType === "awaiting_reply");
  const named = (id: string) =>
    awaiting.some((r) => (r.relatedContactIds as string[] | null)?.includes(id));

  section("The dashboard queue actually contains it");

  check("an unanswered email follow-up is queued", named(waiting.id), `got ${awaiting.length} awaiting_reply row(s)`);
  check("a contact who replied is not", !named(answered.id));
  check("an undirected touch is not", !named(unknown.id));
  check("a contact with a follow-up already booked is not", !named(scheduled.id));
  check("a contact pinned off the constellation is not", !named(hidden.id));
  check(
    "each contact appears at most once across the whole queue",
    new Set(rows.flatMap((r) => (r.relatedContactIds as string[] | null) ?? [])).size ===
      rows.filter((r) => (r.relatedContactIds as string[] | null)?.length).length,
    "the queue upserts one candidate per contact, so awaiting_reply must replace a lower-priority type rather than stack with it"
  );

  section("Widening `direction` did not disturb constellation eligibility");

  // `completeFollowUpWithTouch` used to set direction only for `linkedin_message`, and its
  // comment now claims that recording it on other channels is invisible to closeness — the
  // aggregates are scoped to `interaction_type = 'linkedin_message'`. A comment promising a
  // guarantee the code does not provide is exactly the bug class this file exists to stop,
  // so the claim is measured rather than trusted.
  // The experiment has to vary ONE thing. Adding an interaction row moves closeness through
  // recency and volume no matter what direction says, so the row is created undirected,
  // measured, then stamped `out` in place and measured again. Anything that moves between
  // those two reads is attributable to `direction` and nothing else.
  const subject = await person("Direction Dana");
  await touched(subject.id, [{ type: "email", direction: null, days: 4 }]);

  const before = await recalibrateCloseness(USER);
  await db
    .update(interactions)
    .set({ direction: "out" })
    .where(eq(interactions.contactId, subject.id));
  const after = await recalibrateCloseness(USER);

  const signalsOf = (r: typeof before, id: string) =>
    JSON.stringify(r.constellationSignals.get(id) ?? null);
  check(
    "stamping `out` on an email row moves no constellation signal",
    signalsOf(before, subject.id) === signalsOf(after, subject.id),
    `${signalsOf(before, subject.id)} -> ${signalsOf(after, subject.id)} — if this moved, the comment in completeFollowUpWithTouch is wrong`
  );

  // Read through locals that must exist: comparing two `undefined`s passes without measuring
  // anything, which is the failure this whole file is about.
  const closenessBefore = before.byId.get(subject.id)?.closeness;
  const closenessAfter = after.byId.get(subject.id)?.closeness;
  check("  the contact is actually scored", typeof closenessBefore === "number");
  check(
    "  and closeness does not move either",
    closenessBefore === closenessAfter,
    `${closenessBefore} -> ${closenessAfter}`
  );

  // The control. If direction were inert everywhere, the check above would prove nothing —
  // it is the `linkedin_message` scoping specifically that spares email.
  const li = await person("LinkedIn Lee");
  await touched(li.id, [{ type: "linkedin_message", direction: null, days: 4 }]);
  const beforeLi = await recalibrateCloseness(USER);
  await db
    .update(interactions)
    .set({ direction: "out" })
    .where(eq(interactions.contactId, li.id));
  const afterLi = await recalibrateCloseness(USER);
  check(
    "the same stamp on a LinkedIn row does move one",
    signalsOf(beforeLi, li.id) !== signalsOf(afterLi, li.id),
    `${signalsOf(beforeLi, li.id)} -> ${signalsOf(afterLi, li.id)}`
  );

  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  pureChecks();
  await dbChecks();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll awaiting-reply checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
