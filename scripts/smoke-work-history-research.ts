/**
 * Web-search work history: what a LinkedIn pull stores, and what it refuses to.
 *
 * Runs `researchContactWorkHistory` against PGlite with a fake researcher — no AI key, no
 * network — so it pins the rules that keep a stranger's career off a contact: only a
 * "confident" answer is saved, an extension capture is never overwritten, a recent web
 * history is not searched again, and a model's malformed entries are cleaned first.
 *
 * Run: npx tsx scripts/smoke-work-history-research.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, publicWorkHistory, rateLimitBuckets } from "../src/db/schema";
import {
  PUBLIC_WORK_HISTORY_DAYS,
  readPublicWorkHistory,
  sweepPublicWorkHistory,
  writePublicWorkHistory,
} from "../src/lib/public-work-history";
import { SKIP_GATE_TUNING } from "../src/lib/decisions/catalog";
import type { Engines } from "../src/lib/decisions/engine";
import { parseAnswers, type Decider, type DecisionRequest, type QuestionMap } from "../src/lib/decisions/jev";
import { recheckGateState, WORK_HISTORY_GATE_LIMITS } from "../src/lib/work-history-gates";
import { anthropicWebSearchToolType } from "../src/lib/ai";
import { RateLimitedError } from "../src/lib/rate-limit";
import { aiOperationThinking, aiOperationTier } from "../src/lib/ai-operations";
import { getContactProfile, saveContactProfile, type IncomingExperience } from "../src/lib/contact-profile";
import {
  contactsNeedingWorkHistory,
  jevMarkerUpdate,
  linkedInCaptureContactIds,
  researchContactWorkHistory,
  researchWorkHistories,
  WORK_HISTORY_REFRESH_DAYS,
  type WorkHistoryAnswer,
  type WorkHistoryResearcher,
  type WorkHistorySubject,
} from "../src/lib/work-history-research";

const USER = "smoke-work-history-user";

/** Engines whose Jev answers every question with `p` (null: no answer), counting the asks. */
function scripted(p: number | null): Engines & { asked: number; last: DecisionRequest<QuestionMap> | null } {
  const state = { asked: 0, last: null as DecisionRequest<QuestionMap> | null };
  const jev = {
    async ask(req: DecisionRequest<QuestionMap>) {
      state.asked += 1;
      state.last = req;
      if (p === null) return null;
      const answers = parseAnswers(req.questions, {
        answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { noul: p }])),
      });
      return answers ? { answers, model: "scripted" } : null;
    },
  } as unknown as Decider;
  return { jev, llm: null, get asked() { return state.asked; }, get last() { return state.last; } } as unknown as Engines & {
    asked: number;
    last: DecisionRequest<QuestionMap> | null;
  };
}

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${USER}%`));
  // A shared history left by an earlier run would answer before the fake researcher is asked.
  await db.delete(publicWorkHistory);
}

async function makeContact(fullName: string, linkedinUrl: string | null) {
  const db = await getDb();
  const [row] = await db
    .insert(contacts)
    .values({ userId: USER, fullName, linkedinUrl, company: "Stripe", title: "PM" })
    .returning();
  return row.id;
}

function role(organization: string, extra: Partial<IncomingExperience> = {}): IncomingExperience {
  return {
    kind: "role",
    organization,
    title: "PM",
    fieldOfStudy: null,
    location: null,
    description: null,
    startYear: 2020,
    startMonth: 1,
    endYear: null,
    endMonth: null,
    isCurrent: false,
    ...extra,
  };
}

/** A researcher that answers `answer` and records who it was asked about. */
function fake(answer: Partial<WorkHistoryAnswer>) {
  const asked: WorkHistorySubject[] = [];
  const researcher: WorkHistoryResearcher = async (_userId, subject) => {
    asked.push(subject);
    return { experiences: [], headline: null, confident: true, sources: [], ...answer };
  };
  return { researcher, asked };
}

async function main() {
  await reset();

  // --- the Jev skip marker: set by a skip or veto, cleared by a real search -----------
  const t = new Date("2026-11-11T00:00:00Z");
  check("a Jev skip sets the marker", jevMarkerUpdate("jev_skipped", t) === t);
  check("a Jev veto sets the marker", jevMarkerUpdate("jev_vetoed", t) === t);
  for (const searched of ["saved", "unchanged", "not_found", "unsure"] as const) {
    check(`a real search (${searched}) clears it`, jevMarkerUpdate(searched, t) === null);
  }
  for (const untouched of ["fresh", "rate_limited", "no_ai", "outranked", "error"] as const) {
    check(`no search ran (${untouched}): left alone`, jevMarkerUpdate(untouched, t) === undefined);
  }

  // --- a confident answer is stored as a "web" profile ------------------------------
  const priya = await makeContact("Priya Rao", "https://www.linkedin.com/in/priya-rao");
  const confident = fake({
    headline: "Staff PM at Stripe",
    experiences: [
      role("Google", { startYear: 2016, endYear: 2020, startMonth: 13 }),
      role("Stripe", { startYear: 2020, isCurrent: true }),
      { ...role("MIT"), kind: "education", title: "BS", isCurrent: true },
    ],
  });
  const saved = await researchContactWorkHistory(USER, priya, { researcher: confident.researcher });
  check("a confident answer is saved", saved === "saved", saved);
  const stored = await getContactProfile(USER, priya);
  check("stored as a web profile", stored?.source === "web", String(stored?.source));
  check("every entry is kept", stored?.experiences.length === 3, String(stored?.experiences.length));
  check("the current role is listed first", stored?.experiences[0]?.organization === "Stripe");
  check("the headline is kept", stored?.headline === "Staff PM at Stripe");
  check(
    "the LinkedIn URL is the search's anchor",
    confident.asked[0]?.linkedinUrl === "https://www.linkedin.com/in/priya-rao"
  );
  check("the profile's source URL is the LinkedIn URL", stored?.sourceUrl === "https://www.linkedin.com/in/priya-rao");

  // --- the school research found fills an empty contacts.school, never a set one --------
  const db = await getDb();
  const schoolOf = async (id: string) =>
    (await db.query.contacts.findFirst({ where: eq(contacts.id, id), columns: { school: true } }))?.school ?? null;
  check("an empty school is filled from the education entry", (await schoolOf(priya)) === "MIT", String(await schoolOf(priya)));
  const kept = await makeContact("Kept School", "https://www.linkedin.com/in/kept-school");
  await db.update(contacts).set({ school: "Stanford" }).where(eq(contacts.id, kept));
  await researchContactWorkHistory(USER, kept, {
    researcher: fake({ experiences: [role("Stripe", { isCurrent: true }), { ...role("MIT"), kind: "education" }] }).researcher,
  });
  check("a school already set is never overwritten", (await schoolOf(kept)) === "Stanford", String(await schoolOf(kept)));

  // --- a recent web history is not searched again; a forced search is ----------------
  const again = fake({ experiences: [role("Ramp", { isCurrent: true })] });
  const fresh = await researchContactWorkHistory(USER, priya, { researcher: again.researcher });
  check("a recent web history is not searched again", fresh === "fresh" && again.asked.length === 0, fresh);
  const forced = await researchContactWorkHistory(USER, priya, { researcher: again.researcher, force: true });
  check("a forced search replaces it", forced === "saved" && again.asked.length === 1, forced);
  check(
    "the replacement is the whole history, not a union",
    (await getContactProfile(USER, priya))?.experiences.map((e) => e.organization).join() === "Ramp"
  );
  const later = new Date(Date.now() + (WORK_HISTORY_REFRESH_DAYS + 1) * 86_400_000);
  const stale = fake({ experiences: [role("Ramp", { isCurrent: true })] });
  // Past the freshness window it is due again — via the cheap re-check, which here reports
  // a different employer and so escalates to the full search.
  await researchContactWorkHistory(USER, priya, {
    researcher: stale.researcher,
    checker: async () => ({ confident: true, current: { organization: "Figma", title: "PM" } }),
    now: later,
  });
  check("an old web history is searched again", stale.asked.length === 1);

  // --- anything short of "confident" writes nothing -------------------------------------
  const namesake = await makeContact("John Smith", "https://www.linkedin.com/in/john-smith-42");
  const unsure = await researchContactWorkHistory(USER, namesake, {
    researcher: fake({ confident: false, experiences: [role("Somewhere")] }).researcher,
  });
  check("an unsure answer is not saved", unsure === "unsure", unsure);
  check("an unsure answer leaves no profile", (await getContactProfile(USER, namesake)) === null);
  const none = await researchContactWorkHistory(USER, namesake, {
    researcher: fake({ confident: true, experiences: [] }).researcher,
  });
  check("an empty answer is not_found", none === "not_found", none);

  // --- an empty answer never wipes a stored career --------------------------------------
  const wipe = await researchContactWorkHistory(USER, priya, {
    researcher: fake({ confident: true, experiences: [] }).researcher,
    force: true,
  });
  check("an empty forced search reports not_found", wipe === "not_found", wipe);
  check("…and the stored history survives", ((await getContactProfile(USER, priya))?.experiences.length ?? 0) > 0);

  // --- an extension capture is never overwritten ----------------------------------------
  const captured = await makeContact("Ada Lovelace", "https://www.linkedin.com/in/ada");
  await saveContactProfile(USER, captured, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/ada",
    adapterVersion: "test",
    capturedAt: new Date(),
    warnings: [],
    headline: null,
    about: null,
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [role("Analytical Engines Ltd", { isCurrent: true })],
  });
  const ext = fake({ experiences: [role("Wrong Co")] });
  const outranked = await researchContactWorkHistory(USER, captured, { researcher: ext.researcher, force: true });
  check("an extension capture is never searched over", outranked === "outranked" && ext.asked.length === 0, outranked);

  // --- no LinkedIn URL, no search -------------------------------------------------------
  const noUrl = await makeContact("No Url", null);
  const unanchored = fake({ experiences: [role("Anything")] });
  const noAnchor = await researchContactWorkHistory(USER, noUrl, { researcher: unanchored.researcher });
  check("a contact with no LinkedIn URL is not searched", noAnchor === "no_anchor" && unanchored.asked.length === 0);

  // --- a researcher failure is a value, not a throw -------------------------------------
  const brokenContact = await makeContact("Broken Search", "https://www.linkedin.com/in/broken");
  const broken = await researchContactWorkHistory(USER, brokenContact, {
    researcher: async () => {
      throw new Error("provider down");
    },
  });
  check("a failed search returns error instead of throwing", broken === "error", broken);
  const capped = await researchContactWorkHistory(USER, brokenContact, {
    force: true,
    researcher: async () => {
      throw new RateLimitedError("web-search", 3_600);
    },
  });
  check("a web-search budget refusal is rate_limited, not an error", capped === "rate_limited", capped);

  // --- which contacts a pull hands to the route ---------------------------------------
  const due = await contactsNeedingWorkHistory(USER, [priya, namesake, captured, noUrl, brokenContact]);
  check(
    "only contacts with a URL, no settled history and no recent miss are due",
    due.sort().join() === [brokenContact].sort().join(),
    JSON.stringify(due)
  );

  // --- the miss streak --------------------------------------------------------------------
  const nobody: WorkHistoryResearcher = async () => ({ confident: false, headline: null, sources: [], experiences: [] });
  const ghost = await makeContact("Ghost Person", "https://www.linkedin.com/in/ghost-person");
  const streak = async () =>
    (await (await getDb()).query.contacts.findFirst({ where: eq(contacts.id, ghost) }))!;
  await researchContactWorkHistory(USER, ghost, { force: true, researcher: nobody });
  await researchContactWorkHistory(USER, ghost, { force: true, researcher: nobody });
  const twice = await streak();
  check("two misses are counted against the slug", twice.workHistoryMisses === 2 && twice.workHistoryMissSlug === "ghost-person", JSON.stringify({ m: twice.workHistoryMisses, s: twice.workHistoryMissSlug }));
  await (await getDb()).update(contacts).set({ workHistoryDueAt: new Date(Date.now() - 86_400_000) }).where(eq(contacts.id, ghost));
  check("…and stop a pull from searching them, even once due", (await contactsNeedingWorkHistory(USER, [ghost])).length === 0);
  await (await getDb()).update(contacts).set({ linkedinUrl: "https://www.linkedin.com/in/ghost-person-2" }).where(eq(contacts.id, ghost));
  check("a new LinkedIn URL lifts the streak without anyone resetting it", (await contactsNeedingWorkHistory(USER, [ghost])).join() === ghost);
  await researchContactWorkHistory(USER, ghost, { force: true, researcher: nobody });
  check("a miss on the new slug starts the count over", (await streak()).workHistoryMisses === 1);
  const found = fake({ experiences: [role("Linear", { isCurrent: true })] });
  await researchContactWorkHistory(USER, ghost, { force: true, researcher: found.researcher });
  const cleared = await streak();
  check("a found history clears the streak", cleared.workHistoryMisses === 0 && cleared.workHistoryMissSlug === null);

  // --- the batch runner -----------------------------------------------------------------
  const batch = fake({ experiences: [role("Figma", { isCurrent: true })] });
  const { saved: batchSaved } = await researchWorkHistories(USER, [namesake, brokenContact, namesake], {
    researcher: batch.researcher,
  });
  check("the batch saves each due contact once", batchSaved.length === 2 && batch.asked.length === 2, JSON.stringify(batchSaved));
  const late = fake({ experiences: [role("Figma")] });
  await researchWorkHistories(USER, [namesake], { researcher: late.researcher, deadline: Date.now() - 1 });
  check("a passed deadline starts nobody", late.asked.length === 0);

  // --- capture: only cards that carried a LinkedIn URL -----------------------------------
  const picked = linkedInCaptureContactIds(
    [
      { parsed: { linkedin_url: "https://www.linkedin.com/in/a" } },
      { parsed: { linkedin_url: null } },
      { parsed: { linkedin_url: "  " } },
      { parsed: { linkedin_url: "https://www.linkedin.com/in/d" } },
    ],
    ["c1", "c2", "c3", "c4"]
  );
  check("capture researches only the LinkedIn-linked cards", picked.join() === "c1,c4", picked.join());

  // --- the cheap re-check: one question before the full history ---------------------------
  await reset();
  const recheckAt = new Date(Date.now() + (WORK_HISTORY_REFRESH_DAYS + 5) * 86_400_000);
  const rechecked = await makeContact("Recheck Rao", "https://www.linkedin.com/in/recheck-rao");
  await researchContactWorkHistory(USER, rechecked, {
    researcher: fake({ experiences: [role("Stripe", { isCurrent: true, title: "PM" })] }).researcher,
  });
  const checkerAsked: string[] = [];
  const checker = (current: { organization: string; title: string | null } | null, confident = true) =>
    async (_u: string, subject: WorkHistorySubject) => {
      checkerAsked.push(subject.fullName);
      return { confident, current };
    };

  const full1 = fake({ experiences: [role("Stripe", { isCurrent: true })] });
  const same = await researchContactWorkHistory(USER, rechecked, {
    researcher: full1.researcher,
    checker: checker({ organization: "Stripe, Inc.", title: "PM" }),
    now: recheckAt,
  });
  check("a re-check that confirms the current role is 'unchanged'", same === "unchanged", same);
  check("…and never runs the full history search", full1.asked.length === 0 && checkerAsked.length === 1);
  check(
    "…but records when it was checked",
    (await getContactProfile(USER, rechecked))?.capturedAt.getTime() === recheckAt.getTime()
  );

  const unclear = fake({ experiences: [role("Anything")] });
  const unsureCheck = await researchContactWorkHistory(USER, rechecked, {
    researcher: unclear.researcher,
    checker: checker({ organization: "Somewhere", title: null }, false),
    now: new Date(recheckAt.getTime() + (WORK_HISTORY_REFRESH_DAYS + 1) * 86_400_000),
  });
  check("an unclear re-check does not escalate to the full search", unsureCheck === "not_found" && unclear.asked.length === 0, unsureCheck);

  const full2 = fake({ experiences: [role("Ramp", { isCurrent: true, title: "Staff PM", startYear: 2030 }), role("Stripe", { isCurrent: false, endYear: 2030 })] });
  const moved = await researchContactWorkHistory(USER, rechecked, {
    researcher: full2.researcher,
    checker: checker({ organization: "Ramp", title: "Staff PM" }),
    now: new Date(recheckAt.getTime() + 2 * (WORK_HISTORY_REFRESH_DAYS + 1) * 86_400_000),
  });
  check("a re-check that finds a different job escalates to the full history", moved === "saved" && full2.asked.length === 1, moved);
  check(
    "…which replaces the stored history",
    (await getContactProfile(USER, rechecked))?.experiences[0]?.organization === "Ramp"
  );

  const before = checkerAsked.length;
  const forcedFull = fake({ experiences: [role("Ramp", { isCurrent: true, title: "Staff PM" })] });
  await researchContactWorkHistory(USER, rechecked, {
    researcher: forcedFull.researcher,
    checker: checker({ organization: "Ramp", title: "Staff PM" }),
    force: true,
  });
  check("the profile's button (force) skips the re-check and searches in full", forcedFull.asked.length === 1 && checkerAsked.length === before);

  // --- Jev's re-check gate: the sweep only, never twice in a row (spec 2026-11-10) ----------
  await reset();
  const gated = await makeContact("Gate Rao", "https://www.linkedin.com/in/gate-rao");
  await researchContactWorkHistory(USER, gated, {
    researcher: fake({ experiences: [role("Stripe", { isCurrent: true, title: "PM" })] }).researcher,
  });
  const stillStripe = checker({ organization: "Stripe", title: "PM" });
  const savedThreshold = SKIP_GATE_TUNING.skipAtOrBelow.workHistoryRecheck;
  SKIP_GATE_TUNING.skipAtOrBelow.workHistoryRecheck = 0.2;
  try {
    const DAY = 86_400_000;
    let clock = recheckAt.getTime();
    const later = () => new Date((clock += (WORK_HISTORY_REFRESH_DAYS + PUBLIC_WORK_HISTORY_DAYS + 10) * DAY));
    const gatedRow = async () => (await getDb()).query.contacts.findFirst({ where: eq(contacts.id, gated) });
    const userBuckets = async () =>
      (await getDb()).select().from(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${USER}%`));
    await (await getDb()).delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${USER}%`));

    const checkedBefore = (await getContactProfile(USER, gated))?.capturedAt.getTime();
    const asked0 = checkerAsked.length;
    const low = scripted(0.1);
    const t1 = later();
    const skipped = await researchContactWorkHistory(USER, gated, { gates: low, checker: stillStripe, researcher: fake({}).researcher, now: t1 });
    check("a confident 'no move' from Jev skips the sweep's re-check", skipped === "jev_skipped", skipped);
    check("…asked under the re-check gate's operation", low.last?.operation === "contact.work_history.recheck.gate", String(low.last?.operation));
    check("…the re-check search never runs", checkerAsked.length === asked0);
    check("…the last-checked date is untouched", (await getContactProfile(USER, gated))?.capturedAt.getTime() === checkedBefore);
    check("…no web-search allowance is spent", (await userBuckets()).length === 0);
    const afterSkip = await gatedRow();
    check("…no miss is counted", afterSkip?.workHistoryMisses === 0, String(afterSkip?.workHistoryMisses));
    check("…the marker is set", afterSkip?.workHistoryJevSkippedAt?.getTime() === t1.getTime());
    const dueIn = ((afterSkip?.workHistoryDueAt?.getTime() ?? 0) - t1.getTime()) / DAY;
    check("…and it is due again one interval out (cold: 180 days ±20%)", dueIn >= 144 && dueIn <= 216, String(dueIn));

    const lowAgain = scripted(0.1);
    const again = await researchContactWorkHistory(USER, gated, { gates: lowAgain, checker: stillStripe, researcher: fake({}).researcher, now: later() });
    check("never twice in a row: the run after a skip is not gated", lowAgain.asked === 0 && again === "unchanged", again);
    check("…and that real search clears the marker", (await gatedRow())?.workHistoryJevSkippedAt === null);

    const high = scripted(0.9);
    const asked1 = checkerAsked.length;
    await researchContactWorkHistory(USER, gated, { gates: high, checker: stillStripe, researcher: fake({}).researcher, now: later() });
    check("a likely move runs the re-check", high.asked === 1 && checkerAsked.length === asked1 + 1);

    const silent = scripted(null);
    await researchContactWorkHistory(USER, gated, { gates: silent, checker: stillStripe, researcher: fake({}).researcher, now: later() });
    check("no answer from Jev runs the re-check", silent.asked === 1 && checkerAsked.length === asked1 + 2);

    const plain = await researchContactWorkHistory(USER, gated, { checker: stillStripe, researcher: fake({}).researcher, now: later() });
    check("without the sweep's engines (a refresh someone asked for) nothing is gated", plain === "unchanged" && checkerAsked.length === asked1 + 3, plain);

    const forcedGate = scripted(0.1);
    await researchContactWorkHistory(USER, gated, { gates: forcedGate, checker: stillStripe, researcher: fake({}).researcher, force: true });
    check("the profile's button (force) is never gated", forcedGate.asked === 0);

    // Review Focus 3: a stored history with no current role goes straight to the full search.
    const left = await makeContact("Left Rao", "https://www.linkedin.com/in/left-rao");
    await researchContactWorkHistory(USER, left, { researcher: fake({ experiences: [role("Stripe", { isCurrent: false, endYear: 2024 })] }).researcher });
    const leftGate = scripted(0.1);
    const leftFull = fake({ experiences: [role("Ramp", { isCurrent: true })] });
    await researchContactWorkHistory(USER, left, { gates: leftGate, checker: stillStripe, researcher: leftFull.researcher, now: later() });
    check("no current role on file: the gate is not asked and the full search runs", leftGate.asked === 0 && leftFull.asked.length === 1);
  } finally {
    SKIP_GATE_TUNING.skipAtOrBelow.workHistoryRecheck = savedThreshold;
  }

  // Review Focus 4: what the gate reads is trimmed, recent, and never the raw note.
  const lastCheckedAt = new Date("2026-06-01T00:00:00Z");
  const db4 = await getDb();
  await db4.insert(interactions).values([
    { userId: USER, contactId: gated, interactionDate: new Date("2026-05-01T00:00:00Z"), aiSummary: "Before the last check" },
    { userId: USER, contactId: gated, interactionDate: new Date("2026-07-01T00:00:00Z"), aiSummary: "x".repeat(1_000), rawNotes: "RAW-SECRET" },
    ...Array.from({ length: 12 }, (_, i) => ({
      userId: USER,
      contactId: gated,
      interactionDate: new Date(Date.UTC(2026, 7, 1 + i)),
      aiSummary: `Catch-up ${i}`,
    })),
  ]);
  const state = await recheckGateState(USER, gated, {
    lastCheckedAt,
    roles: [{ organization: "Stripe", title: "PM", startYear: 2020, startMonth: 1, isCurrent: true }],
    closenessTier: null,
    title: "PM",
    company: "Stripe",
    now: new Date("2026-11-11T00:00:00Z"),
  });
  const since = (state.since_last_check as { interactions: Array<{ date: string; summary: string | null }> }).interactions;
  check("the gate reads at most 10 interactions", since.length === WORK_HISTORY_GATE_LIMITS.interactions, String(since.length));
  check("…only ones after the last check", since.every((i) => new Date(i.date) > lastCheckedAt));
  check("…newest first", since[0]?.summary === "Catch-up 11", since[0]?.summary ?? "");
  check("…each summary trimmed", since.every((i) => (i.summary ?? "").length <= WORK_HISTORY_GATE_LIMITS.summaryChars));
  check("…and never the raw note", !JSON.stringify(state).includes("RAW-SECRET"));

  // --- cost: background extraction runs on the cheap tier, thinking minimal ----------------
  check("work-history research runs on the fast tier", aiOperationTier("contact.work_history") === "fast");
  check("…with minimal thinking", aiOperationThinking("contact.work_history") === "minimal");

  // --- Anthropic's search tool version follows the model --------------------------------
  check("Opus 5.5 gets the dynamic-filtering search", anthropicWebSearchToolType("claude-opus-5-5") === "web_search_20260209");
  check("Sonnet 4.6 gets the dynamic-filtering search", anthropicWebSearchToolType("claude-sonnet-4-6") === "web_search_20260209");
  check("Haiku 4.5 gets the basic search", anthropicWebSearchToolType("claude-haiku-4-5") === "web_search_20250305");
  check("Sonnet 4.5 gets the basic search", anthropicWebSearchToolType("claude-sonnet-4-5") === "web_search_20250305");

  await reset();
  // --- the shared public history (public-work-history.ts) ---------------------------------
  const OTHER = `${USER}-other`;
  const source = await makeContact("Twin Source", "https://www.linkedin.com/in/twin-source");
  await researchContactWorkHistory(USER, source, {
    force: true,
    researcher: fake({ experiences: [role("Stripe", { isCurrent: true })] }).researcher,
  });
  const [twin] = await db
    .insert(contacts)
    .values({ userId: OTHER, fullName: "Twin Source", linkedinUrl: "https://www.linkedin.com/in/twin-source", company: "Stripe", title: "PM" })
    .returning();
  const secondAccount = fake({ experiences: [role("Nope", { isCurrent: true })] });
  const reused = await researchContactWorkHistory(OTHER, twin!.id, { researcher: secondAccount.researcher });
  check(
    "a second account with the same profile gets the shared history, with no search",
    reused === "saved" && secondAccount.asked.length === 0,
    reused,
  );
  const lone = await makeContact("Lone Wolf", "https://www.linkedin.com/in/lone-wolf");
  await researchContactWorkHistory(USER, lone, { researcher: fake({ confident: false, experiences: [role("Somewhere")] }).researcher });
  check("an unsure answer is never shared", (await readPublicWorkHistory("lone-wolf", 30)) === null);
  await db.insert(publicWorkHistory).values({ slug: "blocked-one", answer: null, blockedAt: new Date(), blockedBy: "smoke-admin" });
  await writePublicWorkHistory("blocked-one", { headline: null, experiences: [role("Leak", { isCurrent: true })], sources: [] });
  const blockedRow = await db.query.publicWorkHistory.findFirst({ where: eq(publicWorkHistory.slug, "blocked-one") });
  check("a blocked profile is never served or rewritten", (await readPublicWorkHistory("blocked-one", 30)) === null && blockedRow?.answer === null);
  await db.insert(publicWorkHistory).values({ slug: "nobody-has-them", answer: { headline: null, experiences: [role("Gone")], sources: [] } });
  await sweepPublicWorkHistory();
  const left = new Set((await db.select({ slug: publicWorkHistory.slug }).from(publicWorkHistory)).map((r) => r.slug));
  check(
    "the sweep drops a profile no account has, keeps a known one and the takedown",
    !left.has("nobody-has-them") && left.has("twin-source") && left.has("blocked-one"),
    [...left].join(),
  );
  await db.delete(contacts).where(eq(contacts.userId, OTHER));
  await db.delete(publicWorkHistory);

  console.log("\nsmoke-work-history-research: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
