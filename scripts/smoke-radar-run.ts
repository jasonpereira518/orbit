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

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  actionItems,
  aiSuggestions,
  contactCareerMoves,
  contactOpportunities,
  contacts,
  eventAttendees,
  events,
  interactions,
  radarRuns,
  recommendationFeedback,
  recommendations,
  reminders,
  userSettings,
} from "../src/db/schema";
import {
  dismissRecommendationForUser,
  neverForContactForUser,
  restoreRecommendationForUser,
  scheduleRecommendationForUser,
  snoozeRecommendationForUser,
} from "../src/lib/radar/actions-core";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import {
  claimRadarLease,
  claimRadarUsers,
  ensureRadarRun,
  loadRadarState,
  maybeRefreshRadar,
  nextNightlyRunAt,
  runRadarForUser,
} from "../src/lib/radar/run";
import { encrypt } from "../src/lib/crypto";
import { ensureUserSettings } from "../src/lib/user-settings";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import { getAttentionBrief } from "../src/lib/chat-attention";
import { isSurfaceLive } from "../src/lib/surface-visibility";
import { COMING_SOON_KEYS } from "../src/lib/surfaces";
import { loadRadarBriefing } from "../src/lib/radar/page-data";
import { applyAutopilot, undoAutopilotForUser } from "../src/lib/radar/autopilot";
import { draftChannel, draftTodayForRun } from "../src/lib/radar/drafts";
import { openRadarAi } from "../src/lib/radar/explain";
import { listPendingRecommendations, loadModelTallies } from "../src/lib/radar/store";
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
  const firstScores = await db
    .select({ score: recommendations.score, base: recommendations.baseScore })
    .from(recommendations)
    .where(and(eq(recommendations.userId, USER), eq(recommendations.status, "pending")));
  check("with no history, every card's score is its base score", firstScores.length > 0 && firstScores.every((r) => r.score === r.base));
  check("the counts add up", first.inserted === rows.length && first.updated === 0 && first.expired === 0);
  check("no statement selects notes",
    !queries.some((q) => selectsColumn(q, "notes") || selectsColumn(q, "raw_notes")),
    queries.find((q) => selectsColumn(q, "notes") || selectsColumn(q, "raw_notes"))?.slice(0, 120));

  const state = await loadRadarState(USER);
  check("the run is recorded on the account", state?.lastRunAt?.getTime() === NOW.getTime());
  check("the next run is the next nightly slot", state?.nextAt?.getTime() === nextNightlyRunAt(NOW).getTime());
  const [settings] = await db.select({ lease: userSettings.radarLeaseUntil }).from(userSettings).where(eq(userSettings.userId, USER));
  check("the lease is released", settings?.lease === null);

  console.log("\nno AI key");
  await claimRadarLease(USER, NOW);
  const noKey = await runRadarForUser(USER, { trigger: "schedule", now: NOW, ai: true });
  check("a run asked for AI without a key still succeeds", noKey.ok);
  check("and says it skipped the notes", noKey.skippedNoKey && noKey.aiNotes === 0);
  check("every card still has its reasons", (await db.select({ reasons: recommendations.reasons }).from(recommendations).where(eq(recommendations.userId, USER))).every((r) => r.reasons.length > 0));

  console.log("\nwith an AI key (stubbed provider)");
  {
    const sent: string[] = [];
    const reranks: string[] = [];
    let rerankReply: "good" | "garbage" | "neutral" = "good";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!/generativelanguage/.test(url)) return realFetch(input, init);
      // Only text generation is a Radar call. An embedding request (background indexing for
      // the account whose key this block just set) shares the host; answer it, don't count it.
      if (!/:(stream)?generateContent/i.test(url)) return Response.json({ embedding: { values: [] }, embeddings: [] });
      const body = typeof init?.body === "string" ? init.body : "";
      // The rerank is the one call that carries a CANDIDATES fence.
      const isRerank = body.includes("<<<CANDIDATES_");
      (isRerank ? reranks : sent).push(body);
      const reply = isRerank
        ? rerankReply === "garbage"
          ? "not json at all"
          : rerankReply === "neutral"
            ? JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: `c${i + 1}`, adjust: 0, angle: "" })) })
            : JSON.stringify({
              items: [
                { id: "c1", adjust: 40, angle: "Worth a message while it is fresh." },
                { id: "c2", adjust: -9, angle: "Nothing is waiting on you here." },
                { id: "c3", adjust: 3, angle: "Call them in 97 weeks." },
                { id: "c99", adjust: 15, angle: "Not a candidate." },
              ],
            })
        : JSON.stringify({
            why: "You met recently and have not followed up.",
            opener: "Good to meet you at the summit. My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
          });
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: reply }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    }) as typeof fetch;
    await db
      .update(userSettings)
      .set({ aiProvider: "gemini", aiModel: "gemini-3.5-flash", geminiApiKeyEncrypted: encrypt("fake-gemini") })
      .where(eq(userSettings.userId, USER));
    await claimRadarLease(USER, NOW);
    const withAi = await runRadarForUser(USER, { trigger: "schedule", now: NOW, ai: true });
    check("the run writes notes for the top cards", withAi.aiNotes > 0 && withAi.aiNotes <= 5, JSON.stringify(withAi));
    // When it fails, say what the unexpected calls were: a count alone sent the last
    // investigation through a whole CI shard to find out.
    const unexpected = sent.filter((b) => !b.includes("<<<FACTS_")).map((b) => b.slice(0, 600));
    check("one call per note", sent.length === withAi.aiNotes, `${sent.length} calls${unexpected.length ? `; not notes: ${JSON.stringify(unexpected)}` : ""}`);
    check("the facts reach the model fenced", sent.every((b) => b.includes("<<<FACTS_")));
    check("and no notes do", sent.every((b) => !/Met at|raw_notes/.test(b)));

    check("one rerank call per run", reranks.length === 1, `${reranks.length}`);
    check("it moved cards", withAi.reranked > 0 && !withAi.rerankFailed, JSON.stringify(withAi));
    check("the goals and the candidates reach it fenced", reranks.every((b) => b.includes("<<<GOALS_") && b.includes("<<<CANDIDATES_")));
    check("it never sees a name", reranks.every((b) => !/Dormant Dana|Intro Ivan|Inbound Ines|Meeting Mo/.test(b)));
    const moved = await db
      .select({ score: recommendations.score, base: recommendations.baseScore, delta: recommendations.aiDelta, angle: recommendations.aiAngle })
      .from(recommendations)
      .where(and(eq(recommendations.userId, USER), eq(recommendations.status, "pending")));
    const touched = moved.filter((r) => r.delta !== null);
    check("an adjustment is clamped to fifteen points", touched.every((r) => Math.abs(r.delta!) <= 15) && touched.some((r) => r.delta === 15),
      JSON.stringify(touched));
    check("the promoted card keeps its angle", touched.some((r) => r.delta === 15 && r.angle === "Worth a message while it is fresh."));
    check("an angle that invents a number is dropped", touched.every((r) => !(r.angle ?? "").includes("97")));
    check("a card the model was not shown is untouched", moved.some((r) => r.delta === null));

    reranks.length = 0;
    await claimRadarLease(USER, NOW);
    const cachedRun = await runRadarForUser(USER, { trigger: "schedule", now: NOW, ai: true });
    check("an unchanged shortlist reuses the answer without a call", reranks.length === 0 && cachedRun.rerankCached, JSON.stringify(cachedRun));

    // A malformed reply leaves the rules' order: nothing moved, the run still fine.
    await db.execute(sql`DELETE FROM ai_result_cache WHERE user_id = ${USER} AND operation = 'radar.rerank'`);
    rerankReply = "garbage";
    await claimRadarLease(USER, NOW);
    const garbled = await runRadarForUser(USER, { trigger: "schedule", now: NOW, ai: true });
    const afterGarbage = await db
      .select({ delta: recommendations.aiDelta, score: recommendations.score, base: recommendations.baseScore })
      .from(recommendations)
      .where(and(eq(recommendations.userId, USER), eq(recommendations.status, "pending")));
    check("a malformed rerank reply fails soft", garbled.ok && garbled.rerankFailed, JSON.stringify(garbled));
    check("and moves nothing", afterGarbage.every((r) => r.delta === null && r.score === r.base));
    // From here on the model agrees with the rules, so what follows tests the notes alone.
    rerankReply = "neutral";
    const noted = (await db.select({ aiNote: recommendations.aiNote }).from(recommendations).where(eq(recommendations.userId, USER)))
      .map((r) => r.aiNote)
      .filter((n): n is NonNullable<typeof n> => n !== null);
    check("the why is stored", noted.some((n) => n.why.startsWith("You met recently")));
    check("a secret in the reply never reaches the row", noted.every((n) => !n.opener.includes("sk-ant-api03")));
    sent.length = 0;
    await claimRadarLease(USER, NOW);
    const again = await runRadarForUser(USER, { trigger: "schedule", now: NOW, ai: true });
    check("unchanged facts cost no second call", again.aiNotes === 0 && sent.length === 0, `${sent.length} calls`);
    const nextDay = new Date(NOW.getTime() + DAY);
    await claimRadarLease(USER, nextDay);
    await runRadarForUser(USER, { trigger: "schedule", now: nextDay, ai: true });
    check("nor does a day passing", sent.length === 0, `${sent.length} calls`);
    globalThis.fetch = realFetch;
    await db.update(userSettings).set({ geminiApiKeyEncrypted: null }).where(eq(userSettings.userId, USER));
    await db.update(recommendations).set({ aiNote: null }).where(eq(recommendations.userId, USER));
  }

  console.log("\nstatements do not grow with the network");
  await db.insert(contacts).values(scaleContactRows(USER, 300, {}));
  await claimRadarLease(USER, NOW);
  startQueryCount();
  const bigger = await runRadarForUser(USER, { trigger: "manual", now: NOW, ai: false });
  const biggerStatements = stopQueryCount();
  check("the run still succeeds", bigger.ok);
  check("the same statements at 312 contacts as at 12", biggerStatements === statements, `${biggerStatements} vs ${statements}`);
  // 26: the outcome check (`detectRadarOutcomes`), the model's tallies
  // (`loadModelTallies`), the autopilot settings, the job-move read, the news probe and the
  // posts read; see smoke-page-budgets.
  check("and a bounded number of them", statements <= 26, String(statements));

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

  console.log("\nthe rest of the app sees the same list");
  {
    const live = await pending();
    check("nothing points into Radar while it is coming soon",
      (await isSurfaceLive(USER, "page.radar")) === !COMING_SOON_KEYS.has("page.radar"));
    startQueryCount();
    const unasked = await loadNotificationPanel(USER, new Date(), { withAlerts: false });
    stopQueryCount();
    check("the bell has no Radar row unless the viewer can open Radar",
      unasked.radar === undefined && !capturedQueries().some((q) => /\brecommendations\b/.test(q)));
    const panel = await loadNotificationPanel(USER, new Date(), { withAlerts: false, radar: true });
    check("the bell summarises Radar in one line", panel.radar?.count === live.length && (panel.radar?.names.length ?? 0) <= 3, JSON.stringify(panel.radar));
    check("and never as a due item", !panel.items.some((i) => i.url === "/radar"));
    const briefing = await loadRadarBriefing(USER);
    check(
      "the dashboard's briefing leads with the top three",
      briefing.hasRun &&
        briefing.top.length === Math.min(3, live.length) &&
        briefing.top.every((r, i, all) => i === 0 || all[i - 1]!.score >= r.score) &&
        briefing.total === live.length,
      briefing.top.map((r) => `${r.contactName}:${r.score}`).join(", ")
    );
    check("and never counts more drafts than cards", briefing.drafts >= 0 && briefing.drafts <= live.length);
    const radarIds = new Set(live.map((r) => r.contactId));
    startQueryCount();
    await getAttentionBrief(USER);
    stopQueryCount();
    check("chat does not read Radar unless the viewer can open it",
      !capturedQueries().some((q) => /\brecommendations\b/.test(q)));
    const brief = await getAttentionBrief(USER, undefined, { radar: true });
    check("chat's attention brief leads with Radar", brief.suggestions.length > 0 && radarIds.has(brief.suggestions[0]!.id));
    check("with Radar's reasons", brief.suggestions.filter((b) => radarIds.has(b.id)).every((b) => b.reason.length > 0));
    check("and nobody twice", new Set(brief.suggestions.map((b) => b.id)).size === brief.suggestions.length);
  }

  console.log("\nthe card's buttons");
  {
    const live = await pending();
    const pick = (contactId: string) => live.find((r) => r.contactId === contactId)!;

    const job = pick(ids.job);
    const scheduled = await scheduleRecommendationForUser(USER, job.id, 7);
    const [jobRow] = await db.select().from(recommendations).where(eq(recommendations.id, job.id));
    const [jobContact] = await db.select({ next: contacts.nextFollowUpAt }).from(contacts).where(eq(contacts.id, ids.job));
    const jobReminders = await db.select({ id: reminders.id }).from(reminders).where(and(eq(reminders.userId, USER), eq(reminders.contactId, ids.job), eq(reminders.status, "pending")));
    check("Schedule puts a follow-up on the calendar", scheduled.ok && jobContact?.next !== null && jobReminders.length === 1);
    check("and retires the card", jobRow?.status === "accepted");
    check("a second click does nothing", !(await scheduleRecommendationForUser(USER, job.id, 7)).ok);

    const inbound = pick(ids.inbound);
    await snoozeRecommendationForUser(USER, inbound.id, "1w");
    const [snoozedRow] = await db.select().from(recommendations).where(eq(recommendations.id, inbound.id));
    check("Snooze hides the card for a week",
      snoozedRow?.status === "snoozed" && Math.round(((snoozedRow.snoozedUntil?.getTime() ?? 0) - Date.now()) / DAY) === 7);
    check("Undo brings it back", (await restoreRecommendationForUser(USER, inbound.id)).restored);

    const event = pick(ids.event);
    await dismissRecommendationForUser(USER, event.id);
    const dismissedFeedback = await db.select().from(recommendationFeedback).where(eq(recommendationFeedback.recommendationId, event.id));
    check("Dismiss records why the next run should leave it", dismissedFeedback.some((f) => f.action === "dismissed"));
    await restoreRecommendationForUser(USER, event.id);
    const afterUndo = await db.select().from(recommendationFeedback).where(eq(recommendationFeedback.recommendationId, event.id));
    check("and Undo forgets that", !afterUndo.some((f) => f.action === "dismissed"));

    const opportunity = pick(ids.opportunity);
    await neverForContactForUser(USER, opportunity.id);
    await claimRadarLease(USER, later);
    await runRadarForUser(USER, { trigger: "schedule", now: later, ai: false });
    check("'Not for this person' survives the next run", !(await pending()).some((r) => r.contactId === ids.opportunity));
    check("nor does the scheduled contact come back as a new card", !(await pending()).some((r) => r.contactId === ids.job));
    check("Undo on 'not for this person' restores the card", (await restoreRecommendationForUser(USER, opportunity.id)).restored);
    const neverLeft = await db.select().from(recommendationFeedback).where(and(eq(recommendationFeedback.contactId, ids.opportunity), eq(recommendationFeedback.action, "never")));
    check("and lifts the ban", neverLeft.length === 0);
    check("someone else's card is out of reach", !(await dismissRecommendationForUser("someone-else", event.id)).ok);
  }

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

  console.log("\nwhat the account taught it");
  {
    const [learner] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: "Learner Lee", closenessTier: "inner", closenessEvidence: 0.6, firstInteractionAt: ago(400), lastInteractionAt: ago(90) })
      .returning();
    const [history] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: "History Hal", firstInteractionAt: ago(400), lastInteractionAt: ago(20) })
      .returning();
    // Six reconnect cards this account dismissed. Rows only, no feedback: they teach the
    // model without suppressing anyone.
    const learnAt = new Date(later.getTime() + 3 * DAY);
    await db.insert(recommendations).values(
      Array.from({ length: 6 }, () => ({
        userId: USER,
        contactId: history!.id,
        kind: "reconnect" as const,
        score: 30,
        baseScore: 30,
        bucket: "later" as const,
        reasons: [{ code: "dormant", label: "A while", points: 30 }],
        status: "dismissed" as const,
        expiresAt: learnAt,
        inputsHash: "h",
        updatedAt: new Date(learnAt.getTime() - DAY),
      }))
    );
    await db.update(userSettings).set({ radarPaused: 0 }).where(eq(userSettings.userId, USER));
    await claimRadarLease(USER, learnAt);
    const taught = await runRadarForUser(USER, { trigger: "schedule", now: learnAt, ai: false });
    check("the run succeeds with a model", taught.ok, JSON.stringify(taught));
    const [lee] = await db
      .select({ score: recommendations.score, base: recommendations.baseScore, kind: recommendations.kind })
      .from(recommendations)
      .where(and(eq(recommendations.contactId, learner!.id), eq(recommendations.status, "pending")));
    check("a reconnect scores below its base score for an account that dismisses them",
      lee?.kind === "reconnect" && lee.base !== null && lee.score < lee.base, JSON.stringify(lee));
    const [saved] = await db.select({ model: userSettings.radarModel }).from(userSettings).where(eq(userSettings.userId, USER));
    check("the model is saved on the account", saved?.model?.kinds.reconnect?.d === 6 && saved.model.reasons.dormant?.d === 6,
      JSON.stringify(saved?.model));
    await db.delete(contacts).where(inArray(contacts.id, [learner!.id, history!.id]));
  }

  console.log("\njob moves");
  {
    const [mover] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: "Mover Max", company: "Ramp", title: "Staff PM", firstInteractionAt: ago(400), lastInteractionAt: ago(40) })
      .returning();
    await db.insert(contactCareerMoves).values({
      userId: USER,
      contactId: mover!.id,
      kind: "joined",
      fromOrg: "Stripe",
      toOrg: "Ramp",
      toTitle: "Staff PM",
      source: "web",
      dedupeKey: "smoke-radar-move",
      detectedAt: new Date(later.getTime() - 2 * DAY),
    });
    await claimRadarLease(USER, later);
    await runRadarForUser(USER, { trigger: "schedule", now: later, ai: false });
    const [card] = await db
      .select({ kind: recommendations.kind, reasons: recommendations.reasons })
      .from(recommendations)
      .where(and(eq(recommendations.contactId, mover!.id), eq(recommendations.status, "pending")));
    check("a logged job move becomes a heads-up card", card?.kind === "heads_up", JSON.stringify(card));
    check("that says what happened", card?.reasons.some((r) => r.label === "Joined Ramp as Staff PM (from Stripe)") === true);
    await db.delete(contacts).where(eq(contacts.id, mover!.id));
  }

  console.log("\ndrafts and autopilot");
  {
    const [draftee] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: "Draft Dee", email: "dee@x.test", closenessTier: "mid", closenessEvidence: 0.5, firstInteractionAt: ago(300), lastInteractionAt: ago(60) })
      .returning();
    const [pilot] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: "Pilot Pia", closenessTier: "mid", closenessEvidence: 0.5, firstInteractionAt: ago(300), lastInteractionAt: ago(60) })
      .returning();
    const today = (contactId: string, kind: "reach_out" | "reconnect", hash: string) =>
      db
        .insert(recommendations)
        .values({
          userId: USER,
          contactId,
          kind,
          score: 60,
          baseScore: 60,
          bucket: "today",
          reasons: [{ code: "inbound_unanswered", label: "They messaged you and haven’t heard back", points: 60 }],
          evidence: [],
          expiresAt: ahead(7),
          inputsHash: hash,
        })
        .returning()
        .then((r) => r[0]!);
    const draftCard = await today(draftee!.id, "reconnect", "draft-h1");
    const pilotCard = await today(pilot!.id, "reach_out", "pilot-h1");

    // Drafts, on a stubbed provider.
    const draftCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!/generativelanguage/.test(url)) return realFetch(input, init);
      // As above: an embedding request is background indexing, not a draft.
      if (!/:(stream)?generateContent/i.test(url)) return Response.json({ embedding: { values: [] }, embeddings: [] });
      draftCalls.push(typeof init?.body === "string" ? init.body : "");
      const reply = JSON.stringify({ body: "Hi Dee, it has been a while. Coffee next week? My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" });
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: reply }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    }) as typeof fetch;
    await db
      .update(userSettings)
      .set({ aiProvider: "gemini", aiModel: "gemini-3.5-flash", geminiApiKeyEncrypted: encrypt("fake-gemini") })
      .where(eq(userSettings.userId, USER));
    const access = await openRadarAi(USER);
    check("an account with a key can draft", access !== null);
    const drafted = await draftTodayForRun(USER, access!, { deadline: Date.now() + 30_000 });
    const [withDraft] = await db.select().from(recommendations).where(eq(recommendations.id, draftCard.id));
    check("Today's cards get a draft", drafted >= 1 && withDraft?.draft?.body.startsWith("Hi Dee") === true, `${drafted}`);
    check("sent through the background operation", draftCalls.length >= 1);
    check("a draft goes where the conversation is: an unanswered LinkedIn message gets a LinkedIn draft",
      withDraft?.draft?.channel === "linkedin", withDraft?.draft?.channel);
    check("otherwise email when there is an address",
      draftChannel({ reasons: [{ code: "dormant", label: "A while", points: 30 }], hasEmail: true }) === "email");
    check("and LinkedIn when there is not",
      draftChannel({ reasons: [{ code: "dormant", label: "A while", points: 30 }], hasEmail: false }) === "linkedin");
    check("a secret in the reply never reaches the card", !(withDraft?.draft?.body ?? "").includes("sk-ant-api03"));
    check("the draft is tied to the card's facts", withDraft?.draft?.inputsHash === "draft-h1");
    draftCalls.length = 0;
    const again = await draftTodayForRun(USER, access!, { deadline: Date.now() + 30_000 });
    check("unchanged facts cost no second draft", again === 0 && draftCalls.length === 0, `${again} / ${draftCalls.length}`);
    const pageRows = await listPendingRecommendations(USER, 50);
    check("the page gets the draft", pageRows.find((r) => r.id === draftCard.id)?.draft?.body.startsWith("Hi Dee") === true);
    await db.update(recommendations).set({ inputsHash: "draft-h2" }).where(eq(recommendations.id, draftCard.id));
    check("and drops it once the facts move", (await listPendingRecommendations(USER, 50)).find((r) => r.id === draftCard.id)?.draft === null);
    const bell = await loadNotificationPanel(USER, new Date(), { withAlerts: false, radar: true });
    check("the bell counts drafts ready", typeof bell.radar?.drafts === "number");
    globalThis.fetch = realFetch;
    await db.update(userSettings).set({ geminiApiKeyEncrypted: null }).where(eq(userSettings.userId, USER));

    // Autopilot.
    check("autopilot off does nothing", (await applyAutopilot(USER, {}, NOW)) === 0);
    const applied = await applyAutopilot(USER, { reach_out: true }, NOW);
    const [piloted] = await db.select().from(recommendations).where(eq(recommendations.id, pilotCard.id));
    const [pilotContact] = await db.select({ next: contacts.nextFollowUpAt }).from(contacts).where(eq(contacts.id, pilot!.id));
    check("autopilot schedules an opted-in kind", applied === 1 && piloted?.status === "auto_applied", `${applied} ${piloted?.status}`);
    check("and remembers exactly what it set", Boolean(piloted?.autopilot?.reminderId) && pilotContact?.next?.toISOString() === piloted?.autopilot?.dueDate);
    const [otherKind] = await db.select({ status: recommendations.status }).from(recommendations).where(eq(recommendations.id, draftCard.id));
    check("but not a kind left off", otherKind?.status === "pending");
    check("it never acts twice", (await applyAutopilot(USER, { reach_out: true }, NOW)) === 0);

    const undone = await undoAutopilotForUser(USER, pilotCard.id);
    const [afterUndo] = await db.select().from(recommendations).where(eq(recommendations.id, pilotCard.id));
    const [contactAfter] = await db.select({ next: contacts.nextFollowUpAt }).from(contacts).where(eq(contacts.id, pilot!.id));
    const leftover = await db.select().from(reminders).where(eq(reminders.contactId, pilot!.id));
    check("Undo removes the follow-up it set", undone.ok && undone.cleared && leftover.length === 0 && contactAfter?.next === null);
    check("and retires the card without a vote against it", afterUndo?.status === "expired");
    const feedbackLeft = await db.select().from(recommendationFeedback).where(eq(recommendationFeedback.recommendationId, pilotCard.id));
    check("leaving no feedback behind", feedbackLeft.length === 0);

    // A follow-up the person has since moved is theirs: Undo leaves it.
    await db.update(recommendations).set({ status: "pending", autopilot: null, actedAt: null, resolvedAt: null }).where(eq(recommendations.id, pilotCard.id));
    await applyAutopilot(USER, { reach_out: true }, NOW);
    const [again2] = await db.select().from(recommendations).where(eq(recommendations.id, pilotCard.id));
    await db.update(reminders).set({ dueDate: ahead(20) }).where(eq(reminders.id, again2!.autopilot!.reminderId));
    const kept = await undoAutopilotForUser(USER, pilotCard.id);
    const stillThere = await db.select().from(reminders).where(eq(reminders.id, again2!.autopilot!.reminderId));
    check("a follow-up the person moved survives Undo", kept.ok && !kept.cleared && stillThere.length === 1);

    // An autopilot card settles as accepted once its time has passed, and is not a vote.
    await db.update(recommendations).set({ status: "pending", autopilot: null, actedAt: null, resolvedAt: null }).where(eq(recommendations.id, pilotCard.id));
    await db.delete(reminders).where(eq(reminders.contactId, pilot!.id));
    await db.update(contacts).set({ nextFollowUpAt: null }).where(eq(contacts.id, pilot!.id));
    await applyAutopilot(USER, { reach_out: true }, NOW);
    await db.update(recommendations).set({ expiresAt: ago(1) }).where(eq(recommendations.id, pilotCard.id));
    await claimRadarLease(USER, NOW);
    await runRadarForUser(USER, { trigger: "manual", now: NOW, ai: false });
    const [settled] = await db.select({ status: recommendations.status }).from(recommendations).where(eq(recommendations.id, pilotCard.id));
    check("an autopilot card settles as accepted when it expires", settled?.status === "accepted", settled?.status);
    const tallies = await loadModelTallies(USER, NOW);
    const reachVotes = tallies.find((t) => t.scope === "kind" && t.key === "reach_out");
    check("autopilot's own action is not counted as the person's accept", (reachVotes?.a ?? 0) === 0, JSON.stringify(reachVotes));

    await db.delete(contacts).where(inArray(contacts.id, [draftee!.id, pilot!.id]));
  }

  console.log("\nwho the nightly pass claims");
  {
    const opened = USER;
    const unopened = "smoke-radar-run-unopened";
    await db.delete(userSettings).where(eq(userSettings.userId, unopened));
    await ensureUserSettings(unopened);
    const passNow = new Date(later.getTime() + 90 * 3_600_000);
    await db
      .update(userSettings)
      .set({ radarPaused: 0, radarLeaseUntil: null, radarNextAt: later, lastActiveAt: passNow })
      .where(inArray(userSettings.userId, [opened, unopened]));
    // The runner shares one PGlite across scripts: hand back any other account a claim
    // touches, and never run anyone but this script's own users.
    const handBack = async (claimed: string[]) => {
      const others = claimed.filter((u) => u !== opened && u !== unopened);
      if (others.length) await db.update(userSettings).set({ radarLeaseUntil: null }).where(inArray(userSettings.userId, others));
      await db.update(userSettings).set({ radarLeaseUntil: null }).where(inArray(userSettings.userId, [opened, unopened]));
    };
    const gated = await claimRadarUsers(100, passNow, { includeUnopened: false });
    await handBack(gated);
    check("while coming-soon, an account that opened Radar is claimed", gated.includes(opened));
    check("and one that never did is not", !gated.includes(unopened));
    const released = await claimRadarUsers(100, passNow, { includeUnopened: true });
    await handBack(released);
    check("after release, both are", released.includes(opened) && released.includes(unopened));
    await db.update(userSettings).set({ lastActiveAt: new Date(passNow.getTime() - 90 * DAY) }).where(eq(userSettings.userId, unopened));
    const idle = await claimRadarUsers(100, passNow, { includeUnopened: true });
    await handBack(idle);
    check("an account idle for months is left alone", !idle.includes(unopened));
    await db.delete(userSettings).where(eq(userSettings.userId, unopened));
  }

  await reset();
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll radar run checks passed.");
});
