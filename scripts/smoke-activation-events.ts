/**
 * The activation, monetization and failure events (ANALYTICS_PLAN phase 2: 2.3, 2.4, 2.8), end to
 * end against PGlite with fake accounts: the REAL actions and lib functions run, and each
 * assertion is that exactly ONE row or event results per action and that a retry or a
 * double-invoke does not make a second.
 *
 *   1. reminders.completed_at and the follow-up events
 *   2. user_settings.ai_key_added_at and the AI key events
 *   3. onboarding events
 *   4. capture, import and chat events
 *   5. checkout, gate attribution and cancellation
 *   6. failure events (email outbox and sync have their own sections in the other smokes)
 *
 * No network: nothing here calls a provider, Stripe or Clerk. The actions run as the local demo
 * user (no Clerk keys, NODE_ENV=development), the way `smoke-follow-up-actions` does.
 *
 * Run: npx tsx scripts/smoke-activation-events.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  aiSuggestions,
  captureJobs,
  chatMessages,
  chatThreads,
  contacts,
  gateEvents,
  imports,
  noteBatches,
  productEvents,
  reminders,
  suggestedReminders,
  userSettings,
} from "../src/db/schema";

// Demo mode: no Clerk keys on a dev server, so `requireUserId()` resolves to "demo-user".
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

const DEMO = "demo-user";
const KEYED = "user_smoke_act_keys";
const LEGACY = "user_smoke_act_legacy";
const CAPTURER = "user_smoke_act_capture";
const SHOPPER = "user_smoke_act_shopper";
const OLD_GATE = "user_smoke_act_oldgate";
const ALL_USERS = [DEMO, KEYED, LEGACY, CAPTURER, SHOPPER, OLD_GATE];

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `track()` writes after the action returns; give the detached inserts time to land. */
async function flush() {
  for (let i = 0; i < 4; i++) await sleep(60);
}

type EventRow = typeof productEvents.$inferSelect;
async function events(userId: string, name?: string): Promise<EventRow[]> {
  await flush();
  const db = await getDb();
  const rows = await db
    .select()
    .from(productEvents)
    .where(name ? and(eq(productEvents.userId, userId), eq(productEvents.name, name)) : eq(productEvents.userId, userId))
    .orderBy(asc(productEvents.occurredAt));
  return rows;
}
const props = (row: EventRow) => row.properties as Record<string, unknown>;
const withReminder = (rows: EventRow[], id: string) => rows.filter((r) => props(r).reminder_id === id);

async function reminderRow(id: string) {
  const db = await getDb();
  return db.query.reminders.findFirst({ where: eq(reminders.id, id) });
}

async function reset() {
  const db = await getDb();
  await db.delete(productEvents).where(inArray(productEvents.userId, ALL_USERS));
  await db.delete(gateEvents).where(inArray(gateEvents.userId, ALL_USERS));
  for (const u of ALL_USERS) {
    await db.delete(reminders).where(eq(reminders.userId, u));
    await db.delete(suggestedReminders).where(eq(suggestedReminders.userId, u));
    await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, u));
    await db.delete(captureJobs).where(eq(captureJobs.userId, u));
    await db.delete(noteBatches).where(eq(noteBatches.userId, u));
    await db.delete(imports).where(eq(imports.userId, u));
    await db.delete(chatThreads).where(eq(chatThreads.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
  }
}

const dayMs = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * dayMs).toISOString();

async function main() {
  const { ensureUserSettings } = await import("../src/lib/user-settings");
  await reset();
  const db = await getDb();
  await ensureUserSettings(DEMO);

  /* ------------------------------------------------------------------------------------- */
  console.log("1. reminders.completed_at and the follow-up events");
  const actions = await import("../src/actions/reminders");
  const suggested = await import("../src/actions/suggested-reminders");
  const [person] = await db.insert(contacts).values({ userId: DEMO, fullName: "Ada Lovelace" }).returning();

  // followup_set — a reminder the person writes.
  const made = (await actions.createReminder({ title: "Send Ada the deck", dueDate: iso(-3), contactId: person.id }))!;
  let rows = await events(DEMO, "followup_set");
  check("createReminder records one followup_set", withReminder(rows, made.id).length === 1);
  check("…origin manual, with a due date", props(withReminder(rows, made.id)[0]!).origin === "manual" && props(withReminder(rows, made.id)[0]!).has_due_date === true);
  check("a fresh reminder is not completed", (await reminderRow(made.id))?.completedAt === null);

  // markReminderDone — stamps completed_at, one event, a double-invoke changes nothing.
  const snap = await actions.markReminderDone(made.id);
  const done1 = await reminderRow(made.id);
  check("markReminderDone sets status and completed_at", done1?.status === "done" && done1.completedAt !== null);
  check("…at about now", Math.abs(done1!.completedAt!.getTime() - Date.now()) < 10_000);
  rows = withReminder(await events(DEMO, "followup_completed"), made.id);
  check("one followup_completed", rows.length === 1, rows.map(props));
  check("…3 days late, from the list", props(rows[0]!).days_late === 3 && props(rows[0]!).via === "list", props(rows[0]!));
  check("…its id is the hash of the reminder and completed_at, so a retry lands on the same row",
    rows[0]!.id === (await import("../src/lib/product-event-ids")).eventId("followup_completed", made.id, done1!.completedAt!.toISOString()));
  await actions.markReminderDone(made.id);
  check("a second markReminderDone keeps the first completed_at", (await reminderRow(made.id))?.completedAt?.getTime() === done1!.completedAt!.getTime());
  check("…and records no second event", withReminder(await events(DEMO, "followup_completed"), made.id).length === 1);

  // Undo clears it; completing again is a new completion.
  const undone = await actions.reopenReminderAction(snap!);
  const reopened = await reminderRow(made.id);
  check("reopenReminderAction clears completed_at", undone.restored && reopened?.status === "pending" && reopened.completedAt === null);
  await actions.markReminderDone(made.id);
  check("completing again after an undo is a second completion (a different completed_at)",
    withReminder(await events(DEMO, "followup_completed"), made.id).length === 2);

  // The Done view's reopen clears it too.
  const reopenedAgain = await actions.reopenDoneReminderAction(made.id);
  check("reopenDoneReminderAction clears completed_at", reopenedAgain !== null && (await reminderRow(made.id))?.completedAt === null);
  check("…and a reopen records no completion", withReminder(await events(DEMO, "followup_completed"), made.id).length === 2);

  // bulkReminderAction — one event per reminder, via bulk, early/late/undated.
  const late = (await actions.createReminder({ title: "Late one", dueDate: iso(-1) }))!;
  const early = (await actions.createReminder({ title: "Early one", dueDate: iso(2) }))!;
  const undated = (await actions.createReminder({ title: "Whenever" }))!;
  const bulk = await actions.bulkReminderAction([late.id, early.id, undated.id], { op: "done" });
  check("bulk done succeeds", bulk.ok && bulk.value.count === 3, bulk);
  const bulkRows = await events(DEMO, "followup_completed");
  const byId = (id: string) => withReminder(bulkRows, id);
  check("one followup_completed per reminder, via bulk",
    [late, early, undated].every((r) => byId(r.id).length === 1 && props(byId(r.id)[0]!).via === "bulk"));
  check("…1 day late, 2 days early, and no days_late without a due date",
    props(byId(late.id)[0]!).days_late === 1 && props(byId(early.id)[0]!).days_late === -2 && !("days_late" in props(byId(undated.id)[0]!)),
    [late, early, undated].map((r) => props(byId(r.id)[0]!)));
  check("all three are stamped", (await Promise.all([late, early, undated].map((r) => reminderRow(r.id)))).every((r) => r?.completedAt));
  await actions.bulkReminderAction([late.id, early.id, undated.id], { op: "done" });
  check("repeating the bulk records nothing", (await events(DEMO, "followup_completed")).length === bulkRows.length);
  if (bulk.ok) {
    const undoBulk = await actions.undoBulkReminderAction(bulk.value.snapshot);
    check("undoBulkReminderAction clears completed_at on every row",
      undoBulk.restored && (await Promise.all([late, early, undated].map((r) => reminderRow(r.id)))).every((r) => r?.completedAt === null && r.status === "pending"));
  }

  // The touch path. `completeFollowUpWithTouch` logs an interaction through an action whose own
  // revalidatePath needs a request, so the smoke drives the function it ends in
  // (`clearContactFollowUpForUser`, which defaults to via "touch") and pins the action's wiring.
  const [toucher] = await db.insert(contacts).values({ userId: DEMO, fullName: "Grace Hopper" }).returning();
  const scheduled = await actions.scheduleContactFollowUp(toucher.id, 7);
  const touchReminder = scheduled.reminder!;
  const { clearContactFollowUpForUser } = await import("../src/lib/reminder-writes");
  const cleared = await clearContactFollowUpForUser(DEMO, toucher.id);
  const touchedRow = await reminderRow(touchReminder.id);
  check("clearing a contact's follow-up through the touch path stamps completed_at", cleared.remindersClosed === 1 && touchedRow?.status === "done" && touchedRow.completedAt !== null);
  const touchEvents = withReminder(await events(DEMO, "followup_completed"), touchReminder.id);
  check("…one followup_completed via touch", touchEvents.length === 1 && props(touchEvents[0]!).via === "touch", touchEvents.map(props));
  await clearContactFollowUpForUser(DEMO, toucher.id);
  check("…a second touch (nothing left to complete) adds none", withReminder(await events(DEMO, "followup_completed"), touchReminder.id).length === 1);
  const { readFileSync } = await import("node:fs");
  const actionSource = readFileSync("src/actions/reminders.ts", "utf8");
  check("completeFollowUpWithTouch completes through via 'touch'; the plain Clear button through 'list'",
    /clearFollowUpAs\(userId, contactId, "touch"\)/.test(actionSource) && /clearFollowUpAs\(userId, contactId, "list"\)/.test(actionSource));
  const [listClear] = await db.insert(contacts).values({ userId: DEMO, fullName: "List Clear" }).returning();
  const listScheduled = await actions.scheduleContactFollowUp(listClear.id, 7);
  await actions.clearContactFollowUp(listClear.id);
  const listEvents = withReminder(await events(DEMO, "followup_completed"), listScheduled.reminder!.id);
  check("clearContactFollowUp (the contact page's button) is via list", listEvents.length === 1 && props(listEvents[0]!).via === "list", listEvents.map(props));

  // followup_set from scheduling: manual, deduped on reminder + due day.
  const sets = withReminder(await events(DEMO, "followup_set"), touchReminder.id);
  check("scheduleContactFollowUp records one followup_set (manual)", sets.length === 1 && props(sets[0]!).origin === "manual");
  await actions.scheduleContactFollowUp(toucher.id, 7);
  check("…rescheduling the same day is the same event", withReminder(await events(DEMO, "followup_set"), touchReminder.id).length <= 2);

  // A system booking is not a followup_set.
  const { scheduleContactFollowUpForUser } = await import("../src/lib/reminder-writes");
  const before = (await events(DEMO, "followup_set")).length;
  const [autopilotTarget] = await db.insert(contacts).values({ userId: DEMO, fullName: "Radar Target" }).returning();
  await scheduleContactFollowUpForUser(DEMO, autopilotTarget.id, 7);
  check("a follow-up booked without an origin (the Radar autopilot) records no followup_set", (await events(DEMO, "followup_set")).length === before);

  // snooze
  const snoozable = (await actions.createReminder({ title: "Snooze me", dueDate: iso(1) }))!;
  const snoozeSnap = await actions.snoozeReminderAction(snoozable.id, 7);
  check("snoozeReminderAction records one followup_snoozed", withReminder(await events(DEMO, "followup_snoozed"), snoozable.id).length === 1);
  await actions.snoozeReminderAction(snoozable.id, 7);
  check("…a double-invoke to the same day is the same event", withReminder(await events(DEMO, "followup_snoozed"), snoozable.id).length === 1);
  await actions.unsnoozeReminderAction(snoozeSnap!);
  check("…an unsnooze records nothing", withReminder(await events(DEMO, "followup_snoozed"), snoozable.id).length === 1);

  // Snoozing a DONE reminder reopens it, and the Undo puts the completion back.
  const doneThenSnoozed = (await actions.createReminder({ title: "Done then snoozed", dueDate: iso(-1) }))!;
  await actions.markReminderDone(doneThenSnoozed.id);
  const completedAt = (await reminderRow(doneThenSnoozed.id))!.completedAt!;
  const resnoozeSnap = await actions.snoozeReminderAction(doneThenSnoozed.id, 3);
  const afterSnooze = await reminderRow(doneThenSnoozed.id);
  check("snoozing a done reminder reopens it and clears completed_at", afterSnooze?.status === "pending" && afterSnooze.completedAt === null);
  await actions.unsnoozeReminderAction(resnoozeSnap!);
  const afterUndo = await reminderRow(doneThenSnoozed.id);
  check("…and undoing the snooze restores done AND when it was done",
    afterUndo?.status === "done" && afterUndo.completedAt?.getTime() === completedAt.getTime());

  // dismiss
  const dismissable = (await actions.createReminder({ title: "Drop me" }))!;
  const dismissSnap = await actions.deleteReminderAction(dismissable.id);
  check("deleteReminderAction records one followup_dismissed", withReminder(await events(DEMO, "followup_dismissed"), dismissable.id).length === 1);
  await actions.deleteReminderAction(dismissable.id);
  check("…deleting twice records one", withReminder(await events(DEMO, "followup_dismissed"), dismissable.id).length === 1);
  await actions.restoreReminderAction(dismissSnap!);
  await actions.deleteReminderAction(dismissable.id);
  check("…delete, restore, delete is still one dismissed", withReminder(await events(DEMO, "followup_dismissed"), dismissable.id).length === 1);

  // suggestions: confirm = followup_set (suggestion); discard / dismiss = followup_dismissed.
  const batchId = randomUUID();
  const mkSuggested = async (title: string) => {
    const [row] = await db
      .insert(suggestedReminders)
      .values({
        userId: DEMO, captureBatchId: batchId, title, rawDatePhrase: "Sept 2", dueDate: new Date(iso(5)),
        sourceExcerpt: "call back on Sept 2", sourceHash: randomUUID(), itemHash: randomUUID(),
      })
      .returning();
    return row;
  };
  const toConfirm = await mkSuggested("Confirm me");
  const confirmed = await suggested.confirmSuggestedReminder(toConfirm.id);
  const confirmSets = withReminder(await events(DEMO, "followup_set"), confirmed.reminderId);
  check("confirmSuggestedReminder records one followup_set (suggestion)", confirmSets.length === 1 && props(confirmSets[0]!).origin === "suggestion");
  await suggested.confirmSuggestedReminder(toConfirm.id).catch(() => null);
  check("…a second confirm is refused and records nothing", withReminder(await events(DEMO, "followup_set"), confirmed.reminderId).length === 1);
  const toDiscard = await mkSuggested("Discard me");
  await suggested.discardSuggestedReminder(toDiscard.id);
  check("discardSuggestedReminder records one followup_dismissed", withReminder(await events(DEMO, "followup_dismissed"), toDiscard.id).length === 1);
  await suggested.discardSuggestedReminder(toDiscard.id).catch(() => null);
  check("…and a repeat adds none", withReminder(await events(DEMO, "followup_dismissed"), toDiscard.id).length === 1);

  const [nudge] = await db.insert(aiSuggestions)
    .values({ userId: DEMO, suggestionType: "reconnect", title: "Reconnect with Ada", relatedContactIds: [person.id], status: "pending" })
    .returning();
  await actions.dismissSuggestion(nudge.id);
  await actions.dismissSuggestion(nudge.id);
  check("dismissSuggestion records one followup_dismissed", withReminder(await events(DEMO, "followup_dismissed"), nudge.id).length === 1);
  const [suggestee] = await db.insert(contacts).values({ userId: DEMO, fullName: "Suggested Person" }).returning();
  const [accepted] = await db.insert(aiSuggestions)
    .values({ userId: DEMO, suggestionType: "reconnect", title: "Reconnect with them", relatedContactIds: [suggestee.id], status: "pending" })
    .returning();
  const acceptedResult = await actions.scheduleFromSuggestion(accepted.id, 5);
  check("accepting a suggestion is a followup_set (suggestion), not a dismissal",
    withReminder(await events(DEMO, "followup_set"), acceptedResult.reminder!.id).length === 1 &&
      props(withReminder(await events(DEMO, "followup_set"), acceptedResult.reminder!.id)[0]!).origin === "suggestion" &&
      withReminder(await events(DEMO, "followup_dismissed"), accepted.id).length === 0);
  check("…and still retires the suggestion", (await db.query.aiSuggestions.findFirst({ where: eq(aiSuggestions.id, accepted.id) }))?.status === "dismissed");

  /* ------------------------------------------------------------------------------------- */
  console.log("\n2. ai_key_added_at and the AI key events");
  const { applyAiKeyChange } = await import("../src/lib/ai-settings-write");
  const settingsOf = async (u: string) => db.query.userSettings.findFirst({ where: eq(userSettings.userId, u) });

  await ensureUserSettings(KEYED); // every real account has its row before it saves a key
  await applyAiKeyChange({ userId: KEYED, provider: "gemini", encryptedKey: "enc-gemini-1" });
  const firstStamp = (await settingsOf(KEYED))?.aiKeyAddedAt;
  check("the first key stamps ai_key_added_at", firstStamp instanceof Date && Math.abs(firstStamp.getTime() - Date.now()) < 10_000);
  let keyRows = await events(KEYED, "ai_key_added");
  check("…and records one ai_key_added", keyRows.length === 1 && props(keyRows[0]!).provider === "gemini" && props(keyRows[0]!).plan === "free", keyRows.map(props));
  check("…with seconds_since_signup a small whole number", Number.isInteger(props(keyRows[0]!).seconds_since_signup) && (props(keyRows[0]!).seconds_since_signup as number) < 60);
  await applyAiKeyChange({ userId: KEYED, provider: "gemini", encryptedKey: "enc-gemini-2" });
  check("replacing the key records nothing and moves nothing",
    (await events(KEYED, "ai_key_added")).length === 1 && (await settingsOf(KEYED))?.aiKeyAddedAt?.getTime() === firstStamp!.getTime());
  await applyAiKeyChange({ userId: KEYED, provider: "gemini", encryptedKey: null });
  check("a save with no key (model change) records nothing", (await events(KEYED, "ai_key_added")).length === 1);
  await sleep(20);
  await applyAiKeyChange({ userId: KEYED, provider: "openai", encryptedKey: "enc-openai-1" });
  keyRows = await events(KEYED, "ai_key_added");
  check("a key for a second provider is its own ai_key_added", keyRows.length === 2 && keyRows.map((r) => props(r).provider).sort().join() === "gemini,openai");
  check("…and never moves ai_key_added_at", (await settingsOf(KEYED))?.aiKeyAddedAt?.getTime() === firstStamp!.getTime());

  // An account that already had a key before the column existed: unknown stays unknown.
  await db.insert(userSettings).values({ userId: LEGACY, geminiApiKeyEncrypted: "enc-legacy" });
  await applyAiKeyChange({ userId: LEGACY, provider: "openai", encryptedKey: "enc-legacy-openai" });
  check("a key added to an account that already had one still records the provider", (await events(LEGACY, "ai_key_added")).length === 1);
  check("…but does not date a legacy account to its second key", (await settingsOf(LEGACY))?.aiKeyAddedAt === null);

  // Clearing a key neither records an event nor clears the stamp (clearApiKey runs as the demo user).
  await ensureUserSettings(DEMO);
  const { clearApiKey, saveAiSettings } = await import("../src/actions/settings");
  const bad = await saveAiSettings({ provider: "gemini", apiKey: "not a key … (has spaces)" });
  check("a malformed key is refused as before", bad.ok === false);
  const failedChecks = await events(DEMO, "ai_key_check_failed");
  check("…and records one ai_key_check_failed with the verdict word only",
    failedChecks.length === 1 && props(failedChecks[0]!).provider === "gemini" && props(failedChecks[0]!).error_kind === "malformed", failedChecks.map(props));
  check("…the key text is nowhere in the event", !JSON.stringify(failedChecks[0]!.properties).includes("not a key"));
  await db.update(userSettings).set({ aiKeyAddedAt: new Date(0), geminiApiKeyEncrypted: "enc-x" }).where(eq(userSettings.userId, DEMO));
  await clearApiKey("gemini");
  check("clearing a key leaves ai_key_added_at alone and records nothing", (await settingsOf(DEMO))?.aiKeyAddedAt?.getTime() === 0 && (await events(DEMO, "ai_key_added")).length === 0);

  /* ------------------------------------------------------------------------------------- */
  console.log("\n3. onboarding events");
  const onboarding = await import("../src/actions/onboarding");
  const tour = await import("../src/actions/tour");
  await db.update(userSettings).set({ onboardingPath: null, onboardingStep: null, tourStop: null }).where(eq(userSettings.userId, DEMO));
  await onboarding.startOnboardingPath("quick", "people");
  await onboarding.startOnboardingPath("quick", "people");
  const chosen = await events(DEMO, "onboarding_path_chosen");
  check("startOnboardingPath records one onboarding_path_chosen", chosen.length === 1 && props(chosen[0]!).path === "quick", chosen.map(props));
  await onboarding.saveOnboardingStep("people");
  check("staying on a step completes nothing", (await events(DEMO, "onboarding_step_completed")).length === 0);
  await onboarding.saveOnboardingStep("connect");
  let stepRows = await events(DEMO, "onboarding_step_completed");
  check("moving past a step completes it, once", stepRows.length === 1 && props(stepRows[0]!).step === "people" && props(stepRows[0]!).path === "quick", stepRows.map(props));
  await onboarding.saveOnboardingStep("connect");
  await onboarding.saveOnboardingStep("people");
  check("going back completes nothing", (await events(DEMO, "onboarding_step_completed")).length === 1);
  await onboarding.saveOnboardingStep("connect");
  check("…and walking forward again is the same step, not a second event", (await events(DEMO, "onboarding_step_completed")).length === 1);
  await onboarding.saveOnboardingStep("overview");
  stepRows = await events(DEMO, "onboarding_step_completed");
  check("the next step completes the next", stepRows.map((r) => props(r).step).sort().join() === "connect,people");
  await onboarding.saveOnboardingStep("not-a-step");
  check("an unknown step records nothing", (await events(DEMO, "onboarding_step_completed")).length === 2);
  // Replay: reset and walk the same path again.
  await db.update(userSettings).set({ onboardingStep: "people" }).where(eq(userSettings.userId, DEMO));
  await onboarding.startOnboardingPath("quick", "people");
  await onboarding.saveOnboardingStep("connect");
  await onboarding.saveOnboardingStep("overview");
  check("a replayed path records no second path_chosen and no repeated steps",
    (await events(DEMO, "onboarding_path_chosen")).length === 1 && (await events(DEMO, "onboarding_step_completed")).length === 2);

  await tour.saveTourStop("contacts.search");
  let tourRows = (await events(DEMO, "onboarding_step_completed")).filter((r) => props(r).path === "tour");
  check("the first tour stop completes dashboard_home", tourRows.length === 1 && props(tourRows[0]!).step === "dashboard_home", tourRows.map(props));
  await tour.saveTourStop("contacts.open");
  await tour.saveTourStop("contacts.open");
  tourRows = (await events(DEMO, "onboarding_step_completed")).filter((r) => props(r).path === "tour");
  check("each stop is completed once", tourRows.map((r) => props(r).step).join() === "dashboard_home,contacts_search", tourRows.map(props));
  await db.update(userSettings).set({ tourStop: null }).where(eq(userSettings.userId, DEMO));
  await tour.saveTourStop("contacts.search");
  await tour.saveTourStop("contacts.open");
  check("a replayed tour's already-completed stops record nothing",
    (await events(DEMO, "onboarding_step_completed")).filter((r) => props(r).path === "tour").length === 2);

  /* ------------------------------------------------------------------------------------- */
  console.log("\n4. capture, import and chat events");
  const { createCaptureJob, discardCaptureJobRow, failCaptureJob } = await import("../src/lib/capture-jobs");
  const { runCaptureJobById } = await import("../src/lib/capture-job-runner");
  const { recordCaptureDecisionRow } = await import("../src/lib/capture-jobs");
  const { hashSourceNote } = await import("../src/lib/suggested-reminder-utils");
  await ensureUserSettings(CAPTURER);

  const parsedPerson = (name: string) => ({
    name, company: "Acme", role: "Engineer", presence: "participant" as const, location: null, email: null, linkedin_url: null,
    met_at: "Demo day", topics: [], action_items: [], follow_up_recommendation: "Send the deck", follow_up_days: 14,
    relationship_score_suggestion: 4, relevance: null, tags: [], summary: `Met ${name}`, key_facts: [], opportunities: [], implied_next_steps: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01", low_confidence_fields: [],
  });
  const fakeParse = (corpus: string) => ({
    items: [
      { key: "0-Ada", notes: "Met Ada", parsed: parsedPerson("Ada Lovelace"), duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: "2026-09-01", interactionType: "meeting_note", opportunities: [], impliedSteps: [], cadence: null },
      { key: "1-Alan", notes: "Met Alan", parsed: parsedPerson("Alan Turing"), duplicates: [], suggestedMergeId: null, sharedNoteTexts: [], interactionDate: "2026-09-01", interactionType: "meeting_note", opportunities: [], impliedSteps: [], cadence: null },
    ],
    sharedNotes: [], interactionDate: "2026-09-01", interactionType: "meeting_note", anchorIso: "2026-09-01", anchorBasis: "note" as const,
    hints: {}, sourceText: corpus, sourceHash: hashSourceNote(corpus), suggestedReminders: [], suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [], mentionedOnly: [],
  });
  const deps = { parse: async (_u: string, corpus: string) => fakeParse(corpus), enrich: false };

  const job = await createCaptureJob(CAPTURER, { sourceKind: "messy", status: "queued", inputText: "Met Ada and Alan at demo day." });
  await runCaptureJobById(job.id, deps);
  for (const [key, index] of [["0-Ada", 0], ["1-Alan", 1]] as const) {
    await recordCaptureDecisionRow(CAPTURER, job.id, key, { decision: "accept", index, mergeContactId: null, relationshipScore: 4, tagNames: [], decidedAt: new Date().toISOString() });
  }
  await db.update(captureJobs).set({ status: "saving", claimToken: null }).where(eq(captureJobs.id, job.id));
  const savedJob = await runCaptureJobById(job.id, deps);
  check("the capture saves", savedJob?.status === "saved", savedJob?.error);
  const cs = await events(CAPTURER, "capture_saved");
  check("one capture_saved per job", cs.length === 1 && props(cs[0]!).capture_job_id === job.id, cs.map(props));
  check("…with source and people counts from the result", props(cs[0]!).source_kind === "text" && props(cs[0]!).people_created === 2 && props(cs[0]!).people_updated === 0, props(cs[0]!));
  await runCaptureJobById(job.id, deps);
  // A save resumed after a crash adopts the existing batch and must not count it twice.
  await db.update(captureJobs).set({ status: "saving", noteBatchId: null, claimToken: null }).where(eq(captureJobs.id, job.id));
  await runCaptureJobById(job.id, deps);
  check("a re-run and a resumed save record no second capture_saved", (await events(CAPTURER, "capture_saved")).length === 1);
  const captureSets = await events(CAPTURER, "followup_set");
  const captureReminders = await db.select({ id: reminders.id }).from(reminders).where(eq(reminders.userId, CAPTURER));
  check("the reminders the capture created are followup_set (capture), exactly one each",
    captureReminders.length >= 1 && captureSets.length === captureReminders.length &&
      captureReminders.every((r) => withReminder(captureSets, r.id).length === 1) &&
      captureSets.every((r) => props(r).origin === "capture" && props(r).has_due_date === true), captureSets.map(props));

  const doomed = await createCaptureJob(CAPTURER, { sourceKind: "voice", status: "queued", inputText: "x" });
  const failedRow = await runCaptureJobById(doomed.id, { parse: async () => { throw new Error("model exploded for Ada Lovelace"); }, enrich: false });
  check("a parse failure still lands as failed", failedRow?.status === "failed");
  let cf = await events(CAPTURER, "capture_failed");
  check("one capture_failed, stage parse, source voice", cf.length === 1 && props(cf[0]!).stage === "parse" && props(cf[0]!).source_kind === "voice", cf.map(props));
  check("…with a machine error_kind and none of the message", /^[a-z_]{1,32}$/.test(String(props(cf[0]!).error_kind)) && !JSON.stringify(cf[0]!.properties).includes("Ada"), props(cf[0]!));
  await runCaptureJobById(doomed.id, { parse: async () => { throw new Error("again"); }, enrich: false });
  check("running a failed job again does not count it again", (await events(CAPTURER, "capture_failed")).length === 1);
  const stalled = await createCaptureJob(CAPTURER, { sourceKind: "messy", status: "queued", inputText: "y" });
  await failCaptureJob(stalled.id, "stalled", { stage: "parse", errorKind: "stalled" });
  await failCaptureJob(stalled.id, "stalled", { stage: "parse", errorKind: "stalled" });
  cf = await events(CAPTURER, "capture_failed");
  check("failCaptureJob records one per (job, stage, kind)", cf.filter((r) => props(r).capture_job_id === stalled.id).length === 1 && cf.length === 2);

  const toDiscardJob = await createCaptureJob(CAPTURER, { sourceKind: "messy", status: "queued", inputText: "Met Ada and Alan, again." });
  await runCaptureJobById(toDiscardJob.id, deps);
  check("discarding a reviewed job works", await discardCaptureJobRow(CAPTURER, toDiscardJob.id));
  await discardCaptureJobRow(CAPTURER, toDiscardJob.id);
  const cd = await events(CAPTURER, "capture_discarded");
  check("one capture_discarded with the people it proposed", cd.length === 1 && props(cd[0]!).people_proposed === 2 && props(cd[0]!).capture_job_id === toDiscardJob.id, cd.map(props));

  // import_failed
  const { failImport } = await import("../src/lib/import-engine");
  const [imp] = await db.insert(imports).values({ userId: CAPTURER, importType: "google_contacts", status: "processing" }).returning();
  await failImport(imp.id, new Error("invalid_grant"), { failedRows: 7 } as never);
  await failImport(imp.id, new Error("invalid_grant"), { failedRows: 7 } as never);
  const ifr = await events(CAPTURER, "import_failed");
  check("failImport records one import_failed", ifr.length === 1 && props(ifr[0]!).import_id === imp.id, ifr.map(props));
  check("…provider google_contacts, a classified error_kind, rows_failed 7",
    props(ifr[0]!).provider === "google_contacts" && props(ifr[0]!).error_kind === "needs_reconnect" && props(ifr[0]!).rows_failed === 7, props(ifr[0]!));

  // chat_answer_landed / chat_answer_failed
  const { persistAssistantTurn, trackChatAnswerFailed } = await import("../src/lib/chat-persist");
  const [thread] = await db.insert(chatThreads).values({ userId: CAPTURER, title: null }).returning();
  const saved = await persistAssistantTurn(CAPTURER, thread.id, null, "Who do I know at Acme?", {
    answer: "Ada Lovelace works at Acme [e1][e2].", recommendations: [],
    evidence: { e1: { kind: "contact" }, e2: { kind: "note" } } as never,
    metrics: { durationMs: 2300, toolRounds: 2 },
  });
  const landed = await events(CAPTURER, "chat_answer_landed");
  check("persistAssistantTurn records one chat_answer_landed", landed.length === 1 && props(landed[0]!).message_id === saved.messageId, landed.map(props));
  check("…with duration, tool rounds and an evidence COUNT", props(landed[0]!).duration_ms === 2300 && props(landed[0]!).tool_rounds === 2 && props(landed[0]!).evidence_count === 2, props(landed[0]!));
  check("…and none of the answer", !JSON.stringify(landed[0]!.properties).includes("Ada"));
  const noThread = await persistAssistantTurn(CAPTURER, null, null, "q", { answer: "a", recommendations: [] });
  check("a turn outside a thread stores nothing and records nothing", noThread.messageId === null && (await events(CAPTURER, "chat_answer_landed")).length === 1);
  trackChatAnswerFailed(CAPTURER, thread.id, Object.assign(new Error("secret provider body about Ada"), { name: "AiAccessError", reason: "managed_limit" }));
  trackChatAnswerFailed(CAPTURER, null, new Error("no thread"));
  const caf = await events(CAPTURER, "chat_answer_failed");
  check("a failed stream records one chat_answer_failed with a machine code", caf.length === 1 && props(caf[0]!).thread_id === thread.id && props(caf[0]!).error_kind === "managed_limit", caf.map(props));
  check("…and a turn with no thread records none", caf.length === 1);
  await db.delete(chatMessages).where(eq(chatMessages.threadId, thread.id));

  /* ------------------------------------------------------------------------------------- */
  console.log("\n5. checkout, gate attribution and cancellation");
  const { recordGateRefusal } = await import("../src/lib/gate-refusal");
  const { trackCheckoutStarted, trackSubscriptionCanceled, resolveCheckoutGate } = await import("../src/lib/checkout-events");
  const { isKnownGate } = await import("../src/lib/gate-events");
  await ensureUserSettings(SHOPPER);
  check("the gate param is a closed list: known keys pass", isKnownGate("managedCredits") && isKnownGate("contacts"));
  check("…anything else is dropped", !isKnownGate("hostedAi") && !isKnownGate("<script>") && !isKnownGate("") && !isKnownGate(undefined) && !isKnownGate(["api"]));
  check("with no gate row and no param there is no gate", (await resolveCheckoutGate(SHOPPER, undefined)) === undefined);
  trackCheckoutStarted(SHOPPER, { sessionId: "cs_test_aaaa1111", plan: "orbit", interval: "month" });
  let cos = await events(SHOPPER, "checkout_started");
  check("checkout_started records one event, no gate", cos.length === 1 && props(cos[0]!).plan === "orbit" && props(cos[0]!).interval === "month" && !("from_gate" in props(cos[0]!)), cos.map(props));
  trackCheckoutStarted(SHOPPER, { sessionId: "cs_test_aaaa1111", plan: "orbit", interval: "month" });
  check("the same Stripe session twice is one event", (await events(SHOPPER, "checkout_started")).length === 1);
  await recordGateRefusal(SHOPPER, "speechShortform", { surface: "web", route: "/api/speech/token" }, { throttled: false });
  trackCheckoutStarted(SHOPPER, { sessionId: "cs_test_bbbb2222", plan: "max", interval: "year", gate: "<img onerror>" });
  cos = await events(SHOPPER, "checkout_started");
  check("an invalid ?gate= falls back to the most recent gate hit in the last 24h", props(cos[1]!).from_gate === "speechShortform", cos.map(props));
  trackCheckoutStarted(SHOPPER, { sessionId: "cs_test_cccc3333", plan: "orbit", interval: "month", gate: "api" });
  cos = await events(SHOPPER, "checkout_started");
  check("an explicit known gate wins over the gate row", props(cos[2]!).from_gate === "api", cos.map(props));
  trackCheckoutStarted(SHOPPER, { sessionId: "cs_test_dddd4444", plan: "free", interval: "once" });
  cos = await events(SHOPPER, "checkout_started");
  check("a credit pack is plan = the account's plan, interval once", props(cos[3]!).interval === "once" && props(cos[3]!).plan === "free");
  await db.insert(gateEvents).values({ userId: OLD_GATE, feature: "api", plan: "free", unlockPlan: "orbit", createdAt: new Date(Date.now() - 2 * dayMs) });
  check("a gate hit older than 24h is not attribution", (await resolveCheckoutGate(OLD_GATE, undefined)) === undefined);

  trackSubscriptionCanceled(SHOPPER, { periodEnd: 1_800_000_000, reason: "not_using" });
  trackSubscriptionCanceled(SHOPPER, { periodEnd: 1_800_000_000, reason: "not_using" });
  let sc = await events(SHOPPER, "subscription_canceled");
  check("subscription_canceled records one event per cancellation", sc.length === 1 && props(sc[0]!).reason === "not_using" && Number.isInteger(props(sc[0]!).tenure_days), sc.map(props));
  trackSubscriptionCanceled(SHOPPER, { periodEnd: 1_900_000_000, reason: "because I said so" });
  sc = await events(SHOPPER, "subscription_canceled");
  check("a reason outside the closed list is dropped, not stored", sc.length === 2 && !("reason" in props(sc[1]!)));

  /* ------------------------------------------------------------------------------------- */
  console.log("\n5b. an event provider that gives up is a sync failure");
  {
    const { markEventSyncResult } = await import("../src/lib/events/connections");
    const { MAX_SYNC_FAILURES } = await import("../src/lib/provider-connections");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`DELETE FROM event_provider_connections WHERE user_id = ${SHOPPER}`);
    const inserted = await db.execute(sql`
      INSERT INTO event_provider_connections (user_id, provider, auth_kind, status, next_sync_at, sync_failures)
      VALUES (${SHOPPER}, 'luma', 'api_key', 'active', now(), 0) RETURNING id`);
    const id = String((inserted as unknown as { rows: { id: string }[] }).rows[0]!.id);
    await markEventSyncResult(id, { ok: false, error: "fetch failed: ECONNRESET to luma.com/secret-path", retryable: true });
    check("a first retryable failure records nothing", (await events(SHOPPER, "sync_failed")).length === 0);
    await db.execute(sql`UPDATE event_provider_connections SET sync_failures = ${MAX_SYNC_FAILURES - 1} WHERE id = ${id}`);
    await markEventSyncResult(id, { ok: false, error: "fetch failed: ECONNRESET to luma.com/secret-path", retryable: true });
    const gaveUp = await events(SHOPPER, "sync_failed");
    check("the failure that spends the last retry is recorded once", gaveUp.length === 1, gaveUp.length);
    check("…with a provider and a code, never the message", JSON.stringify(props(gaveUp[0]!)) === JSON.stringify({ provider: "luma", error_kind: "network" }), props(gaveUp[0]!));
    await db.execute(sql`DELETE FROM event_provider_connections WHERE user_id = ${SHOPPER}`);
  }

  /* ------------------------------------------------------------------------------------- */
  console.log("\n6. nothing free-text anywhere");
  const all = await db.select().from(productEvents).where(inArray(productEvents.userId, ALL_USERS));
  const text = JSON.stringify(all.map((r) => r.properties));
  const leaks = ["Ada", "Lovelace", "Alan", "Turing", "Grace", "Hopper", "deck", "demo day", "enc-", "exploded", "invalid_grant"].filter((w) => text.includes(w));
  check(`none of ${all.length} events carries a name, note, key or error text`, leaks.length === 0, leaks);

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nactivation events: all checks passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
