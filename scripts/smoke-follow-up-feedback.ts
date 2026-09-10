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

import { eq } from "drizzle-orm";
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
  snoozeSuggestion,
} from "../src/lib/follow-ups/feedback";
import { runFollowUpPass } from "../src/lib/follow-ups/pass";
import { ensureUserSettings } from "../src/lib/user-settings";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const USER = "smoke-follow-up-feedback-user";
const NOW = new Date("2026-09-09T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

async function reset() {
  const db = await getDb();
  await db.delete(followUpSuggestions).where(eq(followUpSuggestions.userId, USER));
  await db.delete(followUpSuppressions).where(eq(followUpSuppressions.userId, USER));
  await db.delete(followUpWeights).where(eq(followUpWeights.userId, USER));
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
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
  check("acceptance suppresses the contact for 30 days", (await db.query.followUpSuppressions.findMany({ where: eq(followUpSuppressions.userId, USER) })).length === 1);

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

  // 40 days on: the 60-day dismissal suppression is still live.
  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 40 * DAY) });
  const at40 = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("40 days later the dismissal still holds", at40.every((r) => r.status === "dismissed"));

  // 70 days on: it has expired, so the contact is eligible again.
  await runFollowUpPass(USER, { now: new Date(NOW.getTime() + 70 * DAY) });
  const at70 = await db.query.followUpSuggestions.findMany({ where: eq(followUpSuggestions.userId, USER) });
  check("70 days later the suppression has expired and they resurface", at70.some((r) => r.status === "pending"));

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

  await reset();
  console.log("\nAll follow-up feedback checks passed.\n");
}

// `run` is the repo's own preamble helper: tsx will not exit on its own while PGlite's
// workers are alive, and every db-tier script in this repo ends this way.
run(main);
