/**
 * "Log who you met": a capture opened from an event, saved through the real runner against
 * PGlite with the model stubbed out.
 *
 * What has to hold: everyone saved is marked met on the event and linked to their contact, a
 * guest who was already on the roster stays one row, each person gets an `event` interaction,
 * a follow-up exists, and a job pointing at somebody else's event saves its people without
 * writing anything onto that event. Plus the morning-after nudge (`lastUnloggedEvent`): offered
 * for an event nobody has logged, and gone once a debrief starts.
 *
 * Run: npx tsx scripts/smoke-capture-event-link.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-capture-event-link";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-capture-event-link";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, contacts, eventAttendees, events, interactions, noteBatches, reminders, userSettings } from "../src/db/schema";
import { createCaptureJob, recordCaptureDecisionRow } from "../src/lib/capture-jobs";
import { runCaptureJobById } from "../src/lib/capture-job-runner";
import type { CaptureParseResult } from "../src/lib/capture/types";
import { createEventForUser, listRosterForUser, upsertEventAttendees } from "../src/lib/events/store";
import { parseRosterText } from "../src/lib/events/parse-roster";
import { lastUnloggedEvent } from "../src/lib/meeting-context";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-capture-event-link-user";
const OTHER = "smoke-capture-event-link-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function person(name: string, email: string | null) {
  return {
    name, company: "Acme", role: "Engineer", presence: "participant" as const, location: null, email, linkedin_url: null,
    met_at: "Founders Mixer", topics: [], action_items: [], follow_up_recommendation: `Follow up with ${name}`, follow_up_days: 7,
    relationship_score_suggestion: 4, relevance: null, tags: [], summary: `Met ${name}`, key_facts: [], opportunities: [], implied_next_steps: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-10-24", low_confidence_fields: [],
  };
}

function fakeParse(corpus: string): CaptureParseResult {
  const item = (key: string, name: string, email: string | null) => ({
    key, notes: `Met ${name}`, parsed: person(name, email), duplicates: [], suggestedMergeId: null, sharedNoteTexts: [],
    interactionDate: "2026-10-24", interactionType: "event", opportunities: [], impliedSteps: [], cadence: null,
  });
  return {
    items: [item("0-Ada Lovelace", "Ada Lovelace", "ada@analytical.io"), item("1-Raj Patel", "Raj Patel", null)],
    sharedNotes: [],
    interactionDate: "2026-10-24",
    interactionType: "event",
    anchorIso: "2026-10-24",
    anchorBasis: "note",
    hints: {},
    sourceText: corpus,
    sourceHash: hashSourceNote(corpus),
    suggestedReminders: [],
    suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [],
    mentionedOnly: [],
  };
}

const deps = { parse: async (_userId: string, corpus: string) => fakeParse(corpus), enrich: false };

async function reset() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await db.delete(captureJobs).where(eq(captureJobs.userId, user));
    await db.delete(reminders).where(eq(reminders.userId, user));
    await db.delete(interactions).where(eq(interactions.userId, user));
    await db.delete(noteBatches).where(eq(noteBatches.userId, user));
    await db.delete(eventAttendees).where(eq(eventAttendees.userId, user));
    await db.delete(events).where(eq(events.userId, user));
    await db.delete(contacts).where(eq(contacts.userId, user));
    await db.delete(userSettings).where(eq(userSettings.userId, user));
  }
  await ensureUserSettings(USER);
}

/** Extract, accept every card, save — the way the review flow drives the runner. */
async function captureAndSave(eventId: string, text: string) {
  const db = await getDb();
  const job = await createCaptureJob(USER, {
    sourceKind: "messy",
    status: "queued",
    inputText: text,
    inputHints: { interactionType: "event", metAt: "Founders Mixer" },
    eventId,
  });
  const ready = await runCaptureJobById(job.id, deps);
  check("the job extracts", ready?.status === "ready", `${ready?.status} ${ready?.error}`);
  for (const [index, key] of ["0-Ada Lovelace", "1-Raj Patel"].entries()) {
    await recordCaptureDecisionRow(USER, job.id, key, {
      decision: "accept", index, mergeContactId: null, relationshipScore: 4, tagNames: [], decidedAt: new Date().toISOString(),
    });
  }
  await db.update(captureJobs).set({ status: "saving", claimToken: null }).where(eq(captureJobs.id, job.id));
  const saved = await runCaptureJobById(job.id, deps);
  check("the save lands", saved?.status === "saved", `${saved?.status} ${saved?.error}`);
  return saved!;
}

async function main() {
  await reset();
  const db = await getDb();

  const event = await createEventForUser(USER, { title: "Founders Mixer", startsAt: new Date("2026-10-24T23:00:00Z") });
  // Ada was on the guest list already; Raj was not.
  await upsertEventAttendees(USER, event.id, parseRosterText("Ada Lovelace <ada@analytical.io>").attendees, "paste");

  console.log("The morning after…");
  const morning = new Date("2026-10-25T14:00:00Z");
  check("an unlogged event is offered the next morning", (await lastUnloggedEvent(USER, morning))?.eventId === event.id);
  check("but not before it has ended", (await lastUnloggedEvent(USER, new Date("2026-10-24T23:30:00Z"))) === null);
  check("nor two days later", (await lastUnloggedEvent(USER, new Date("2026-10-27T14:00:00Z"))) === null);
  const hidden = await createEventForUser(USER, { title: "Hidden", startsAt: new Date("2026-10-25T01:00:00Z") });
  await db.update(events).set({ dismissedAt: new Date() }).where(eq(events.id, hidden.id));
  check("a hidden event is never offered", (await lastUnloggedEvent(USER, morning))?.eventId === event.id);

  console.log("\nLogging who you met…");
  await captureAndSave(event.id, "Met at Founders Mixer: Ada (infra hiring), Raj — follow up next week.");

  const people = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  check("both people are contacts", people.map((p) => p.fullName).sort().join() === "Ada Lovelace,Raj Patel", people.map((p) => p.fullName).join());

  const roster = await listRosterForUser(USER, event.id);
  check("the guest already listed is still one row", roster.filter((r) => r.fullName === "Ada Lovelace").length === 1, `${roster.length} rows`);
  check("the new person is on the event", roster.some((r) => r.fullName === "Raj Patel" && r.source === "capture"));
  check("everyone is marked met", roster.length === 2 && roster.every((r) => r.spokeTo));
  check(
    "and linked to their contact",
    roster.every((r) => people.some((p) => p.id === r.contactId)),
    JSON.stringify(roster.map((r) => r.contactId))
  );

  const logged = await db.query.interactions.findMany({
    where: and(eq(interactions.userId, USER), inArray(interactions.contactId, people.map((p) => p.id))),
  });
  check("each person has an event interaction", people.every((p) => logged.some((i) => i.contactId === p.id && i.interactionType === "event")), logged.map((i) => i.interactionType).join());

  const followUps = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  check("follow-ups were created", followUps.length > 0 && followUps.every((r) => people.some((p) => p.id === r.contactId)), String(followUps.length));

  check("once people are logged the nudge stands down", (await lastUnloggedEvent(USER, morning)) === null);
  const started = await createEventForUser(USER, { title: "Debrief started", startsAt: new Date("2026-10-24T22:00:00Z") });
  check("a later unlogged event is offered", (await lastUnloggedEvent(USER, morning))?.eventId === started.id);
  await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "Met someone", eventId: started.id });
  check("and stands down as soon as its debrief starts", (await lastUnloggedEvent(USER, morning)) === null);

  console.log("\nSomebody else's event…");
  const theirs = await createEventForUser(OTHER, { title: "Not yours" });
  await captureAndSave(theirs.id, "Different notes so the corpus is new: Ada and Raj again.");
  check("nothing is written onto it", (await db.query.eventAttendees.findMany({ where: eq(eventAttendees.eventId, theirs.id) })).length === 0);

  await reset();
  console.log("\nAll capture-event checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
