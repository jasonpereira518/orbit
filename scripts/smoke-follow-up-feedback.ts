/**
 * The feedback loop: accept, snooze, dismiss, mute, mark-sent.
 *
 * The assertions that matter most are the negative ones — that a dismissed reason does
 * not come back on the next pass, and that a mute never does.
 *
 * Run: npx tsx scripts/smoke-follow-up-feedback.ts
 */
import "./smoke/_env";

import { run } from "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contacts,
  followUpSuggestions,
  followUpSuppressions,
  followUpWeights,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import {
  acceptSuggestion,
  dismissSuggestion,
  markSuggestionSent,
  muteContact,
  recomputeWeight,
  snoozeSuggestion,
} from "../src/lib/follow-ups/feedback";
import { runFollowUpPass } from "../src/lib/follow-ups/pass";
import { SIGNAL_TRIGGER } from "../src/lib/follow-ups/registry";
import { isSuppressed, userWeight, WEIGHT_MAX, WEIGHT_MIN } from "../src/lib/follow-ups/score";
import type { SignalKind } from "../src/lib/follow-ups/types";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-follow-up-feedback-user";
const OTHER_USER = "smoke-follow-up-feedback-other-user";
const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

// Same source `refutedByRecentContact` reads and `acceptSuggestion` now derives its
// suppression set from — never hardcode this list separately.
const STALENESS_KINDS = Object.entries(SIGNAL_TRIGGER)
  .filter(([, trigger]) => trigger === "staleness")
  .map(([kind]) => kind as SignalKind);
const DATE_KINDS = Object.entries(SIGNAL_TRIGGER)
  .filter(([, trigger]) => trigger === "date")
  .map(([kind]) => kind as SignalKind);

async function reset() {
  const db = await getDb();
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, USER));
  await db.delete(followUpSuppressions).where(eq(followUpSuppressions.userId, USER));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, OTHER_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function seedOneDormantContact(name: string) {
  const db = await getDb();
  const [c] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: name,
      closenessTier: "inner",
      lastInteractionAt: ago(120),
      firstInteractionAt: ago(400),
      dateMet: ago(400),
    })
    .returning();
  return c.id;
}

async function main() {
  const db = await getDb();

  console.log("\naccept creates the reminder");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Accept Me");
  await runFollowUpPass(USER, { now: NOW });
  let suggestion = (await db.query.followUpSuggestions.findFirst({
    where: eq(followUpSuggestions.userId, USER),
  }))!;
  check("a suggestion exists before accepting", Boolean(suggestion));

  const before = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("no reminder exists before accepting", before.length === 0);

  const { reminderId } = await acceptSuggestion(USER, suggestion.id, { now: NOW });
  const after = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("accepting creates exactly one reminder", after.length === 1);
  check("the reminder is a follow_up", after[0].actionKind === "follow_up");
  check("the suggestion links to it", (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) }))!.reminderId === reminderId);
  check("the suggestion is marked accepted", (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) }))!.status === "accepted");
  const contactAfter = await db.query.contacts.findFirst({ where: eq(contacts.id, suggestion.contactId) });
  check("accepting sets next_follow_up_at", contactAfter?.nextFollowUpAt !== null);
  const weightAfterAccept = await db.query.followUpWeights.findFirst({ where: eq(followUpWeights.userId, USER) });
  check("accepting increments the accepted counter", weightAfterAccept?.accepted === 1);

  // Finding A: acceptance must suppress the staleness-triggered kinds only — one row
  // per kind, derived from SIGNAL_TRIGGER — never a single contact-wide `kind: null`
  // row, which would also silence date-triggered kinds like a birthday.
  const suppressionsAfterAccept = await db.query.followUpSuppressions.findMany({
    where: eq(followUpSuppressions.userId, USER),
  });
  check(
    "acceptance writes one suppression per staleness kind, not one contact-wide row",
    suppressionsAfterAccept.length === STALENESS_KINDS.length
  );
  check(
    "every suppression row is scoped to this contact and a specific staleness kind",
    suppressionsAfterAccept.every(
      (s) =>
        s.contactId === suggestion.contactId &&
        s.kind !== null &&
        (STALENESS_KINDS as string[]).includes(s.kind)
    )
  );
  const suppressionsForIsSuppressed = suppressionsAfterAccept.map((s) => ({
    contactId: s.contactId,
    kind: s.kind,
    until: s.until,
  }));
  check(
    "a staleness signal for this contact is suppressed after accepting",
    STALENESS_KINDS.every((k) =>
      isSuppressed(k, suggestion.contactId, suppressionsForIsSuppressed, NOW)
    )
  );
  check(
    "a date-triggered signal for the same contact is NOT suppressed after accepting",
    DATE_KINDS.every((k) => !isSuppressed(k, suggestion.contactId, suppressionsForIsSuppressed, NOW))
  );

  console.log("\naccepting keeps them off the next pass");
  await runFollowUpPass(USER, { now: NOW });
  const pendingAfterAccept = await db.query.followUpSuggestions.findMany({
    where: eq(followUpSuggestions.userId, USER),
  });
  check(
    "the accepted contact does not get a fresh pending suggestion",
    pendingAfterAccept.every((r) => r.status !== "pending")
  );

  console.log("\ndismiss suppresses, and the next pass respects it");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Dismiss Me");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await dismissSuggestion(USER, suggestion.id, "not_now", { now: NOW });
  check("the row is dismissed", (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) }))!.status === "dismissed");
  check("the dismissed counter went up", (await db.query.followUpWeights.findFirst({ where: eq(followUpWeights.userId, USER) }))!.dismissed === 1);
  // Finding B: "not_now" must write a contact-wide suppression (kind: null) — assert
  // the actual row contents so a swap with "wrong_reason" (which scopes to the kind)
  // would fail here.
  const notNowSuppression = await db.query.followUpSuppressions.findFirst({
    where: eq(followUpSuppressions.userId, USER),
  });
  check("not_now suppresses the whole contact", notNowSuppression?.contactId === suggestion.contactId);
  check("not_now's suppression is NOT scoped to a single kind", notNowSuppression?.kind === null);

  // 40 days on: the 60-day dismissal suppression is still live.
  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 40 * DAY) });
  const at40 = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("40 days later the dismissal still holds", at40.every((r) => r.status === "dismissed"));

  // 70 days on: it has expired, so the contact is eligible again.
  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 70 * DAY) });
  const at70 = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("70 days later the suppression has expired and they resurface", at70.some((r) => r.status === "pending"));

  console.log("\ndismiss with \"wrong_reason\" scopes to the kind, not the whole contact");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Wrong Reason");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await dismissSuggestion(USER, suggestion.id, "wrong_reason", { now: NOW });
  check("the row is dismissed", (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) }))!.status === "dismissed");
  check("the dismissed counter went up", (await db.query.followUpWeights.findFirst({ where: eq(followUpWeights.userId, USER) }))!.dismissed === 1);
  const wrongReasonSuppression = await db.query.followUpSuppressions.findFirst({
    where: eq(followUpSuppressions.userId, USER),
  });
  check("wrong_reason suppresses only this contact", wrongReasonSuppression?.contactId === suggestion.contactId);
  check(
    "wrong_reason's suppression IS scoped to the suggestion's specific kind, not contact-wide",
    wrongReasonSuppression?.kind === suggestion.primaryKind
  );

  console.log("\n\"stop this kind\" is permanent");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Stop This Kind");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await dismissSuggestion(USER, suggestion.id, "stop_this_kind", { now: NOW });
  const kindMute = await db.query.followUpSuppressions.findFirst({ where: eq(followUpSuppressions.userId, USER) });
  check("a kind-wide mute is written", kindMute?.kind === suggestion.primaryKind);
  check("it applies to every contact", kindMute?.contactId === null);
  check("it never expires", kindMute?.until === null);

  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 400 * DAY) });
  const yearLater = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("400 days later the muted kind still never fires", yearLater.every((r) => r.status !== "pending"));

  console.log("\nmuteContact");
  await reset();
  await ensureUserSettings(USER);
  const mutedId = await seedOneDormantContact("Muted Person");
  await muteContact(USER, mutedId);
  const passAfterMute = await runFollowUpPass(USER, { now: NOW });
  check("a muted contact produces no suggestion", passAfterMute.written === 0);
  check("but they were still detected — the mute is a filter, not a blind spot", passAfterMute.detected > 0);

  console.log("\nmuteContact refuses to mute a contact you do not own");
  const [otherContact] = await db
    .insert(contacts)
    .values({ userId: OTHER_USER, fullName: "Someone Else's Contact", closenessTier: "inner" })
    .returning();
  let muteThrew = false;
  try {
    await muteContact(USER, otherContact.id);
  } catch {
    muteThrew = true;
  }
  check("muting another user's contact throws rather than silently inserting", muteThrew);
  const suppressionsAfterBadMute = await db.query.followUpSuppressions.findMany({
    where: eq(followUpSuppressions.userId, USER),
  });
  check(
    "no suppression row was written for the disowned contact",
    suppressionsAfterBadMute.every((s) => s.contactId !== otherContact.id)
  );

  console.log("\nsnooze");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Snooze Me");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await snoozeSuggestion(USER, suggestion.id, 7, { now: NOW });
  const snoozed = await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) });
  check("the row is snoozed", snoozed?.status === "snoozed");
  check("snoozedUntil is seven days out", snoozed?.snoozedUntil?.getTime() === NOW.getTime() + 7 * DAY);
  await snoozeSuggestion(USER, suggestion.id, 9999, { now: NOW });
  const clamped = await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) });
  check("an absurd snooze is clamped to 90 days", clamped?.snoozedUntil?.getTime() === NOW.getTime() + 90 * DAY);
  // Finding E: the clamp's low end was untested — pin 0 and a negative value to 1 day.
  await snoozeSuggestion(USER, suggestion.id, 0, { now: NOW });
  const clampedZero = await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) });
  check("a snooze of 0 days is clamped up to 1 day", clampedZero?.snoozedUntil?.getTime() === NOW.getTime() + 1 * DAY);
  await snoozeSuggestion(USER, suggestion.id, -5, { now: NOW });
  const clampedNegative = await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.id, suggestion.id) });
  check("a negative snooze is also clamped to 1 day", clampedNegative?.snoozedUntil?.getTime() === NOW.getTime() + 1 * DAY);

  console.log("\nmarkSuggestionSent logs the interaction");
  await reset();
  await ensureUserSettings(USER);
  await seedOneDormantContact("Sent Outside Orbit");
  await runFollowUpPass(USER, { now: NOW });
  suggestion = (await db.query.followUpSuggestions.findFirst({ where: eq(followUpSuggestions.userId, USER) }))!;
  await markSuggestionSent(USER, suggestion.id, { now: NOW });
  const logged = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("an outbound interaction was logged", logged.length === 1 && logged[0].direction === "out");
  const touched = await db.query.contacts.findFirst({ where: eq(contacts.id, suggestion.contactId) });
  check("last_interaction_at moved to now", touched?.lastInteractionAt?.getTime() === NOW.getTime());
  // This is the payoff: the logged interaction now trips the 7-day filter by itself.
  const passAfterSent = await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 2 * DAY) });
  check("the 7-day filter now suppresses them with no extra bookkeeping", passAfterSent.written === 0);

  console.log("\nrecomputeWeight's real computation matches userWeight (Finding C)");
  // Every other scenario in this file resets weights and runs one or two passes, so
  // `shown` never reaches WEIGHT_MIN_SHOWN and only the early-return `weight = 1`
  // branch ever runs. Seed `follow_up_weights` rows directly, past the pin threshold,
  // with a lopsided accepted/dismissed record per kind, so the real formula runs.
  await reset();
  await ensureUserSettings(USER);
  const weightSeed: { kind: SignalKind; shown: number; accepted: number; dismissed: number }[] = [
    // Near-unanimous acceptance: should pull toward the upper clamp once the other
    // kinds below drag the mean well under it.
    { kind: "dormant", shown: 20, accepted: 20, dismissed: 0 },
    // Near-unanimous rejection, duplicated across two kinds so the low performers
    // dominate the mean enough to push `dormant` past WEIGHT_MAX and themselves past
    // WEIGHT_MIN on the low side.
    { kind: "open_loop", shown: 20, accepted: 0, dismissed: 20 },
    { kind: "thread_quiet", shown: 20, accepted: 0, dismissed: 20 },
    // A middling kind whose ratio should land inside the clamp bounds — the one we
    // check against an exact computed value rather than just a clamp boundary.
    { kind: "post_event", shown: 20, accepted: 10, dismissed: 10 },
  ];
  for (const row of weightSeed) {
    await db.insert(followUpWeights).values({ userId: USER, ...row });
  }

  // Mirrors `recomputeWeight`'s own mean calculation exactly (Laplace-smoothed
  // acceptance rate, averaged over every kind past WEIGHT_MIN_SHOWN) so the expected
  // values below are derived, not restated magic numbers.
  const laplaceRate = (r: { accepted: number; shown: number }) => (r.accepted + 1) / (r.shown + 2);
  const expectedMean = weightSeed.reduce((acc, r) => acc + laplaceRate(r), 0) / weightSeed.length;

  for (const row of weightSeed) {
    await recomputeWeight(USER, row.kind);
    const stored = await db.query.followUpWeights.findFirst({
      where: and(eq(followUpWeights.userId, USER), eq(followUpWeights.kind, row.kind)),
    });
    const expected = userWeight(
      { kind: row.kind, weight: 0, shown: row.shown, accepted: row.accepted, dismissed: row.dismissed },
      expectedMean
    );
    // `follow_up_weights.weight` is a Postgres `real` (single-precision float4), so a
    // round trip through the database loses precision beyond ~1e-7 even when the two
    // sides agree exactly — looser than the file's usual pure-JS float epsilon.
    check(
      `recomputeWeight("${row.kind}") matches userWeight's formula`,
      Math.abs((stored?.weight ?? Number.NaN) - expected) < 1e-6,
      `stored=${stored?.weight} expected=${expected}`
    );
  }

  const dormantWeight = await db.query.followUpWeights.findFirst({
    where: and(eq(followUpWeights.userId, USER), eq(followUpWeights.kind, "dormant")),
  });
  check("the near-unanimous accepted kind clamps at WEIGHT_MAX", dormantWeight?.weight === WEIGHT_MAX);
  const openLoopWeight = await db.query.followUpWeights.findFirst({
    where: and(eq(followUpWeights.userId, USER), eq(followUpWeights.kind, "open_loop")),
  });
  check("the near-unanimous dismissed kind clamps at WEIGHT_MIN", openLoopWeight?.weight === WEIGHT_MIN);
  const postEventWeight = await db.query.followUpWeights.findFirst({
    where: and(eq(followUpWeights.userId, USER), eq(followUpWeights.kind, "post_event")),
  });
  check(
    "the middling kind lands strictly between the clamp bounds — a real, unclamped value",
    (postEventWeight?.weight ?? 0) > WEIGHT_MIN && (postEventWeight?.weight ?? 0) < WEIGHT_MAX
  );

  await reset();
  console.log("\nAll follow-up feedback checks passed.\n");
}

// `run` is the repo's own preamble helper: tsx will not exit on its own while PGlite's
// workers are alive, and every db-tier script in this repo ends this way.
run(main);
