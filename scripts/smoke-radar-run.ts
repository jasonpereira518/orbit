/**
 * Radar's per-account run, end to end on a throwaway PGlite.
 *
 * One account holds one contact per rule the run must honour: a dormant close tie, a fresh
 * intro, a LinkedIn message nobody answered, a meeting on the calendar, an open action item,
 * an opportunity coming due, an upcoming event, a job-feed match — and the people it must
 * leave alone: pinned off the constellation, a follow-up already set, "not for this person",
 * and an imported contact whose closeness is a guess.
 *
 * Asserts one card per person with the right kind, every exclusion, a statement count that
 * does not grow with the network, no scan of notes, and a second run that changes nothing.
 * Leaves nothing behind: the smoke runner shares one PGlite across scripts.
 *
 * Run: npx tsx scripts/smoke-radar-run.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, inArray, notInArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems,
  aiSuggestions,
  contactOpportunities,
  contacts,
  eventAttendees,
  events,
  interactions,
  radarRuns,
  recommendationFeedback,
  recommendations,
  userSettings,
} from "../src/db/schema";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import {
  claimRadarLease,
  ensureRadarRun,
  loadRadarState,
  maybeRefreshRadar,
  nextNightlyRunAt,
  runRadarForUser,
} from "../src/lib/radar/run";
import { ensureUserSettings } from "../src/lib/user-settings";
import { scaleContactRows } from "./lib/scale-fixture";

const USER = "smoke-radar-run-user";
const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Selected as a value, quoted (Drizzle) or bare (raw SQL). `raw_notes` must not match `notes`. */
function selectsColumn(statement: string, column: string) {
  return new RegExp(`(^|[\\s,.(])"?${column}"?\\s*(,|\\bfrom\\b)`, "i").test(statement);
}

async function reset() {
  const db = await getDb();
  await db.delete(radarRuns).where(eq(radarRuns.userId, USER));
  await db.delete(aiSuggestions).where(eq(aiSuggestions.userId, USER));
  await db.delete(events).where(eq(events.userId, USER));
  // Contacts cascade to interactions, action items, opportunities, recommendations, feedback.
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function seed() {
  const db = await getDb();
  await ensureUserSettings(USER);
  const person = async (key: string, over: Partial<typeof contacts.$inferInsert> = {}) => {
    const [row] = await db
      .insert(contacts)
      .values({
        userId: USER,
        fullName: key,
        company: "Acme",
        firstInteractionAt: ago(400),
        lastInteractionAt: ago(20),
        closenessTier: "outer",
        closenessEvidence: 0.1,
        ...over,
      })
      .returning();
    return row!.id;
  };

  const ids = {
    dormant: await person("Dormant Dana", { closenessTier: "inner", closenessEvidence: 0.6, closeness: 90, lastInteractionAt: ago(60) }),
    intro: await person("Intro Ivan", { firstInteractionAt: ago(10), lastInteractionAt: ago(10) }),
    inbound: await person("Inbound Ines", { closenessTier: "mid", closenessEvidence: 0.5, lastInteractionAt: ago(9) }),
    meeting: await person("Meeting Mo", { lastInteractionAt: ahead(2) }),
    item: await person("Item Ike", { lastInteractionAt: ago(3) }),
    opportunity: await person("Opp Olu"),
    event: await person("Event Eve"),
    job: await person("Job Jo", { closenessTier: "mid", closenessEvidence: 0.5 }),
    pinned: await person("Pinned Pat", { closenessTier: "inner", closenessEvidence: 0.9, lastInteractionAt: ago(80), constellationPin: "out" }),
    scheduled: await person("Scheduled Sam", { priorityLevel: 2, lastInteractionAt: ago(80), nextFollowUpAt: ahead(3) }),
    never: await person("Never Nia", { priorityLevel: 3, lastInteractionAt: ago(80) }),
    guessed: await person("Guessed Gus", { closenessTier: "mid", closenessEvidence: 0.1, lastInteractionAt: ago(80) }),
  };

  await db.insert(interactions).values([
    { userId: USER, contactId: ids.inbound, interactionType: "linkedin_message", interactionDate: ago(40), direction: "out" },
    { userId: USER, contactId: ids.inbound, interactionType: "linkedin_message", interactionDate: ago(9), direction: "in" },
    { userId: USER, contactId: ids.meeting, interactionType: "meeting", interactionDate: ahead(2), source: "calendar_sync", aiSummary: "Quarterly sync" },
  ]);
  const [itemInteraction] = await db
    .insert(interactions)
    .values({ userId: USER, contactId: ids.item, interactionType: "note", interactionDate: ago(20) })
    .returning();
  await db.insert(actionItems).values({
    userId: USER,
    contactId: ids.item,
    interactionId: itemInteraction!.id,
    text: "Send the pitch deck",
    itemHash: "smoke-radar-item",
    createdAt: ago(20),
  });
  await db.insert(contactOpportunities).values({
    userId: USER,
    contactId: ids.opportunity,
    kind: "referral",
    label: "Referral to the platform team",
    status: "open",
    dueDate: ahead(4),
  });
  const [event] = await db.insert(events).values({ userId: USER, title: "AI Summit", startsAt: ahead(3), endsAt: ahead(3) }).returning();
  await db.insert(eventAttendees).values({
    eventId: event!.id,
    userId: USER,
    fullName: "Event Eve",
    contactId: ids.event,
    identityKey: "smoke-radar-eve",
  });
  await db.insert(aiSuggestions).values({
    userId: USER,
    suggestionType: "job_posting_signal",
    title: "New roles at Acme",
    description: "3 new roles at Acme — Job Jo works there",
    relatedContactIds: [ids.job],
    createdAt: ago(2),
  });
  await db.insert(recommendationFeedback).values({ userId: USER, contactId: ids.never, kind: null, action: "never" });
  return ids;
}

async function pending() {
  const db = await getDb();
  return db
    .select({ id: recommendations.id, contactId: recommendations.contactId, kind: recommendations.kind, aiNote: recommendations.aiNote })
    .from(recommendations)
    .where(and(eq(recommendations.userId, USER), eq(recommendations.status, "pending")));
}

run(async () => {
  const db = await getDb();
  await reset();
  const ids = await seed();

  console.log("\nthe lease");
  check("an idle account can be claimed", await claimRadarLease(USER, NOW));
  check("a claimed one cannot be claimed twice", !(await claimRadarLease(USER, NOW)));

  console.log("\nthe first run");
  startQueryCount();
  const first = await runRadarForUser(USER, { trigger: "manual", now: NOW, ai: false });
  const statements = stopQueryCount();
  const queries = capturedQueries();
  check("the run succeeds", first.ok, JSON.stringify(first));
  const rows = await pending();
  const kindOf = (id: string) => rows.filter((r) => r.contactId === id).map((r) => r.kind).join(",");
  check("a dormant close tie is a reconnect", kindOf(ids.dormant) === "reconnect", kindOf(ids.dormant));
  check("a fresh intro is a reach_out", kindOf(ids.intro) === "reach_out", kindOf(ids.intro));
  check("an unanswered message is a reach_out", kindOf(ids.inbound) === "reach_out", kindOf(ids.inbound));
  check("a meeting on the calendar is prep", kindOf(ids.meeting) === "prep", kindOf(ids.meeting));
  check("an open action item is a follow_up", kindOf(ids.item) === "follow_up", kindOf(ids.item));
  check("an opportunity coming due is a follow_up", kindOf(ids.opportunity) === "follow_up", kindOf(ids.opportunity));
  check("an upcoming event is prep", kindOf(ids.event) === "prep", kindOf(ids.event));
  check("a job-feed match is an opportunity", kindOf(ids.job) === "opportunity", kindOf(ids.job));
  check("pinned off the constellation is left alone", kindOf(ids.pinned) === "");
  check("a scheduled follow-up is left to Reminders", kindOf(ids.scheduled) === "");
  check("'not for this person' is left alone", kindOf(ids.never) === "");
  check("a guessed closeness is not dormancy", kindOf(ids.guessed) === "");
  check("one card per person", new Set(rows.map((r) => r.contactId)).size === rows.length);
  check("the counts add up", first.inserted === rows.length && first.updated === 0 && first.expired === 0);
  check("no statement selects notes",
    !queries.some((q) => selectsColumn(q, "notes") || selectsColumn(q, "raw_notes")),
    queries.find((q) => selectsColumn(q, "notes") || selectsColumn(q, "raw_notes"))?.slice(0, 120));

  const state = await loadRadarState(USER);
  check("the run is recorded on the account", state?.lastRunAt?.getTime() === NOW.getTime());
  check("the next run is the next nightly slot", state?.nextAt?.getTime() === nextNightlyRunAt(NOW).getTime());
  const [settings] = await db.select({ lease: userSettings.radarLeaseUntil }).from(userSettings).where(eq(userSettings.userId, USER));
  check("the lease is released", settings?.lease === null);

  console.log("\nstatements do not grow with the network");
  await db.insert(contacts).values(scaleContactRows(USER, 300, {}));
  await claimRadarLease(USER, NOW);
  startQueryCount();
  const bigger = await runRadarForUser(USER, { trigger: "manual", now: NOW, ai: false });
  const biggerStatements = stopQueryCount();
  check("the run still succeeds", bigger.ok);
  check("the same statements at 312 contacts as at 12", biggerStatements === statements, `${biggerStatements} vs ${statements}`);
  check("and a bounded number of them", statements <= 20, String(statements));

  // Back to the named cast, so the caps are decided by the people the checks below name.
  const named = Object.values(ids);
  await db.delete(contacts).where(and(eq(contacts.userId, USER), notInArray(contacts.id, named)));
  await claimRadarLease(USER, NOW);
  await runRadarForUser(USER, { trigger: "manual", now: NOW, ai: false });

  console.log("\na second run changes nothing");
  const before = await pending();
  await db.update(recommendations).set({ aiNote: { why: "w", opener: "o", inputsHash: "h", generatedAt: NOW.toISOString() } }).where(eq(recommendations.id, before[0]!.id));
  await claimRadarLease(USER, NOW);
  const second = await runRadarForUser(USER, { trigger: "schedule", now: NOW, ai: false });
  const after = await pending();
  check("nothing inserted, nothing expired", second.inserted === 0 && second.expired === 0, JSON.stringify(second));
  check("the same rows", JSON.stringify(after.map((r) => r.id).sort()) === JSON.stringify(before.map((r) => r.id).sort()));
  check("an AI note survives unchanged inputs", after.find((r) => r.id === before[0]!.id)?.aiNote?.why === "w");

  console.log("\nwhat the person does sticks");
  const dormantRec = after.find((r) => r.contactId === ids.dormant)!;
  await db.update(recommendations).set({ status: "snoozed", snoozedUntil: ahead(5) }).where(eq(recommendations.id, dormantRec.id));
  await claimRadarLease(USER, NOW);
  await runRadarForUser(USER, { trigger: "schedule", now: NOW, ai: false });
  const [snoozed] = await db.select().from(recommendations).where(eq(recommendations.id, dormantRec.id));
  check("a live snooze survives a run", snoozed?.status === "snoozed");
  check("and is not replaced by a new card", !(await pending()).some((r) => r.contactId === ids.dormant));
  const later = new Date(NOW.getTime() + 6 * DAY);
  await claimRadarLease(USER, later);
  await runRadarForUser(USER, { trigger: "schedule", now: later, ai: false });
  const [woken] = await db.select().from(recommendations).where(eq(recommendations.id, dormantRec.id));
  check("an ended snooze wakes the same row", woken?.status === "pending");

  const introRec = (await pending()).find((r) => r.contactId === ids.intro)!;
  await db.update(recommendations).set({ status: "dismissed", resolvedAt: later }).where(eq(recommendations.id, introRec.id));
  await db.insert(recommendationFeedback).values({ userId: USER, contactId: ids.intro, recommendationId: introRec.id, kind: introRec.kind, action: "dismissed", createdAt: later });
  await claimRadarLease(USER, later);
  await runRadarForUser(USER, { trigger: "schedule", now: later, ai: false });
  check("a dismissal is not re-raised the next night", !(await pending()).some((r) => r.contactId === ids.intro));

  const itemRec = (await pending()).find((r) => r.contactId === ids.item)!;
  await db.update(contacts).set({ title: "Head of Platform" }).where(eq(contacts.id, ids.item));
  await db.update(recommendations).set({ aiNote: { why: "w", opener: "o", inputsHash: "h", generatedAt: NOW.toISOString() } }).where(eq(recommendations.id, itemRec.id));
  await claimRadarLease(USER, later);
  await runRadarForUser(USER, { trigger: "schedule", now: later, ai: false });
  const [itemAfter] = await db.select().from(recommendations).where(eq(recommendations.id, itemRec.id));
  check("an AI note is dropped when what it was written from changes", itemAfter?.aiNote === null);

  console.log("\nfirst visit and stale page views");
  check("a first-visit build does not repeat once a run exists", !(await ensureRadarRun(USER, later)));
  const runsBefore = await db.select({ id: radarRuns.id }).from(radarRuns).where(eq(radarRuns.userId, USER));
  await maybeRefreshRadar(USER, new Date(later.getTime() + 60_000));
  const runsAfter = await db.select({ id: radarRuns.id }).from(radarRuns).where(eq(radarRuns.userId, USER));
  check("a fresh list is not rebuilt on a page view", runsAfter.length === runsBefore.length);
  await maybeRefreshRadar(USER, new Date(later.getTime() + 25 * 3_600_000));
  const runsStale = await db.select({ id: radarRuns.id }).from(radarRuns).where(eq(radarRuns.userId, USER));
  check("a day-old list is", runsStale.length === runsBefore.length + 1);

  await db.update(userSettings).set({ radarPaused: 1 }).where(eq(userSettings.userId, USER));
  await maybeRefreshRadar(USER, new Date(later.getTime() + 60 * 3_600_000));
  const runsPaused = await db.select({ id: radarRuns.id }).from(radarRuns).where(eq(radarRuns.userId, USER));
  check("a paused account is never run", runsPaused.length === runsStale.length);

  const fresh = "smoke-radar-run-fresh";
  await db.delete(userSettings).where(eq(userSettings.userId, fresh));
  await ensureUserSettings(fresh);
  check("a brand-new account gets its first build inline", await ensureRadarRun(fresh, NOW));
  await db.delete(radarRuns).where(inArray(radarRuns.userId, [fresh]));
  await db.delete(userSettings).where(eq(userSettings.userId, fresh));

  await reset();
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll radar run checks passed.");
});
