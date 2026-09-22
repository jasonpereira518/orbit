/**
 * The tasks `scripts/eval-ai.ts` runs. Each calls the PRODUCTION entry point a user's
 * action reaches — `runCaptureParse`, `classifyRecruiterSender`, `parseProfileFields`,
 * `transcribeImagePages`, `transcribeAudioWithAI`, the chat pipeline, the meeting digest —
 * so the eval measures the code that ships, prompts and post-processing included, not a
 * copy of a prompt.
 *
 * Every task returns metrics where each is either a rate in [0, 1] or a count; the gate's
 * rules (`scripts/eval-fixtures/ai-eval-thresholds.json`) say which direction is worse.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../src/db";
import { chatMessages, chatThreads, contactTags, contacts, interactions, memoryChunks, tags } from "../../src/db/schema";
import { runCaptureParse } from "../../src/lib/capture-parse";
import { classifyRecruiterSender, RECRUITER_CONFIDENCE_FLOOR, RULED_OUT_VERDICT } from "../../src/lib/recruiter-scan";
import { looksLikeRecruiter } from "../../src/lib/recruiter-detect";
import { openDecider, type AnswerFor, type Decider, type Question } from "../../src/lib/decisions/jev";
import { admitRecruiterCandidates, rulesOutRecruiter } from "../../src/lib/decisions/recruiter";
import { gateRosters, routeChatQuestion } from "../../src/lib/decisions/chat-route";
import { understandQuery } from "../../src/lib/chat-retrieval";
import { findOrgRosters } from "../../src/lib/chat-roster";
import { openEngines } from "../../src/lib/decisions/engine";
import { personCard, samePersonProbabilities } from "../../src/lib/decisions/duplicates";
import { decideCaptureChecks, decideMentions, whichContact } from "../../src/lib/decisions/capture";
import { calendarEventState, decideCalendarEvents } from "../../src/lib/decisions/calendar";
import { classifyCalendarEvent } from "../../src/lib/calendar-classify";
import type { ParsedCalendarEvent } from "../../src/lib/calendar-import";
import { decide, decideEach } from "../../src/lib/decisions/engine";
import { CAPTURE_CHECK_TUNING, SKIP_GATE_TUNING, calendarKindQuestion, presenceQuestion } from "../../src/lib/decisions/catalog";
import { gateProbability, type GateName } from "../../src/lib/decisions/gates";
import { looksLikeReferral } from "../../src/lib/opportunity-kinds";
import type { BulkNotePersonPreview } from "../../src/lib/capture/types";
import { DUPLICATE_TUNING } from "../../src/lib/decisions/catalog";
import { buildDuplicateIndex, findDuplicateCandidatesIndexed, DUPLICATE_MERGE_CONFIDENCE } from "../../src/lib/duplicates";
import { resolveMentions } from "../../src/lib/mention-resolution";
import { parseProfileFields } from "../../src/lib/extension/parse-profile";
import type { PageContext } from "../../src/lib/extension/contract";
import {
  chatWithNetwork,
  completeJson,
  parseAiJson,
  transcribeAudioWithAI,
  transcribeImagePages,
} from "../../src/lib/ai";
import { prepareChatContext } from "../../src/lib/chat-context";
import { maybeGather } from "../../src/lib/chat-gather";
import { runEmbeddingBackfill } from "../../src/lib/embedding-backfill";
import { loadPassageFixture, seedPassageNotes } from "./eval-passage-notes";
import { rebuildContactEmbeddingsBatch } from "../../src/lib/search";
import { analyzeMeetingTranscript } from "../../src/lib/meeting-digest";
import type {
  CalendarEvalFixture,
  CaptureChecksEvalFixture,
  SkipGatesEvalFixture,
  DuplicatesEvalFixture,
  EvalCard,
  MentionsEvalFixture,
  ChatRoutingEvalFixture,
  CaptureEvalFixture,
  ChatEvalFixture,
  DigestEvalFixture,
  ExtensionEvalFixture,
  OcrEvalFixture,
  RecruiterEvalFixture,
  ResearchEvalFixture,
  TranscribeEvalFixture,
} from "./eval-ai-fixtures";
import {
  characterErrorRate,
  count,
  mean,
  mentions,
  rate,
  sameField,
  scoreResearchAnswer,
  sameName,
  tally,
  wordErrorRate,
  calibrationBins,
  type CalibrationBin,
  type TaskMetrics,
} from "./eval-ai-score";

export type TaskResult = {
  metrics: TaskMetrics;
  cases: number;
  /** Case ids that failed outright (threw) or missed something the gate cares about. */
  misses: string[];
  latenciesMs: number[];
  /**
   * With `--decisions jev`: the decision model's probabilities against the labels, per
   * decision operation — the reliability table its thresholds (decisions/catalog.ts) are
   * tuned from. Reported, never gated.
   */
  calibration?: Record<string, CalibrationBin[]>;
};

export type TaskName =
  | "capture"
  | "recruiter"
  | "recruiter-prefilter"
  | "recruiter-gate"
  | "chat-routing"
  | "duplicates"
  | "mentions"
  | "calendar"
  | "capture-checks"
  | "skip-gates"
  | "extension"
  | "ocr"
  | "transcribe"
  | "chat"
  | "research"
  | "digest";

export const TASK_NAMES: TaskName[] = [
  "capture",
  "recruiter",
  "recruiter-prefilter",
  "recruiter-gate",
  "chat-routing",
  "duplicates",
  "mentions",
  "calendar",
  "capture-checks",
  "skip-gates",
  "extension",
  "ocr",
  "transcribe",
  "chat",
  "research",
  "digest",
];

/** Overridable so the harness itself can be exercised on throwaway fixtures. */
export const FIXTURE_DIR = process.env.ORBIT_EVAL_FIXTURE_DIR || join(process.cwd(), "scripts", "eval-fixtures");

function fixture<T>(file: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as T;
}

/**
 * Private labels exported from a real account (`scripts/export-decision-labels.ts`), when the
 * run names a folder with `--labels-dir`. Never committed: the folder lives outside the repo
 * and holds real contacts. Same shape as the committed fixture; ids prefixed `own-`.
 */
function privateLabels<T>(file: string): T | null {
  const dir = process.env.ORBIT_EVAL_LABELS_DIR;
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
  } catch {
    return null;
  }
}

async function timed<T>(latencies: number[], run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    latencies.push(Date.now() - started);
  }
}

type RunOpts = { userId: string; limit?: number; log: (line: string) => void };

/**
 * The account's decider, wrapped to remember every answer it hands back — yes/no, choice and
 * score alike — by operation, in call order, so a task can line the model's claims up against
 * its labels without asking anything twice. Null when the run has no TypeSafe key.
 */
export type RecordedAnswer = AnswerFor<Question>;

async function recordingDecider(userId: string): Promise<{ decider: Decider; seen: Map<string, RecordedAnswer[]> } | null> {
  const inner = await openDecider(userId);
  if (!inner) return null;
  const seen = new Map<string, RecordedAnswer[]>();
  const decider: Decider = {
    async ask(request, opts) {
      const result = await inner.ask(request, opts);
      if (result) {
        const list = seen.get(request.operation) ?? [];
        for (const key of Object.keys(request.questions)) list.push(result.answers[key] as RecordedAnswer);
        seen.set(request.operation, list);
      }
      return result;
    },
  };
  return { decider, seen };
}

/** The probability of "yes" in a recorded answer, when it was a yes/no. */
function yesProbability(answer: RecordedAnswer | undefined): number | undefined {
  return answer?.type === "noul" ? answer.probability : undefined;
}

/* ------------------------------------------------------------------------ capture ----- */

export async function runCaptureTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<CaptureEvalFixture>("ai-capture-eval.json").cases.slice(0, limit);
  const people = tally();
  const precision = tally();
  const fields = tally();
  const opportunities = tally();
  const referrals = tally();
  const reminders = tally();
  let phantomParticipants = 0;
  let forbiddenHits = 0;
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const result = await timed(latenciesMs, () =>
        runCaptureParse(userId, c.notes, c.hints ?? null, {
          // Noon local, so a relative phrase can never slip a day on a timezone edge.
          now: new Date(`${c.today}T12:00:00`),
          goals: [],
        })
      );
      const cards = result.items.map((i) => i.parsed);
      let missed = false;

      for (const want of c.expect.people) {
        const idx = result.items.findIndex((i) => sameName(want.name, i.parsed.name));
        count(people, idx >= 0);
        if (idx < 0) {
          missed = true;
          continue;
        }
        const item = result.items[idx];
        for (const key of ["company", "role", "email"] as const) {
          const expected = want[key];
          if (expected) count(fields, sameField(expected, item.parsed[key]));
        }
        for (const kind of want.opportunityKinds ?? []) {
          const found = item.opportunities.some((o) => o.kind === kind);
          count(opportunities, found);
          if (kind === "referral") count(referrals, found);
          if (!found) missed = true;
        }
      }
      for (const card of cards) {
        count(precision, c.expect.people.some((p) => sameName(p.name, card.name)));
      }
      for (const name of c.expect.notParticipants ?? []) {
        if (cards.some((card) => sameName(name, card.name))) {
          phantomParticipants += 1;
          missed = true;
        }
      }
      for (const want of c.expect.reminders ?? []) {
        const found = result.suggestedReminders.some(
          (r) =>
            r.dueDateIso === want.dueDate &&
            (!want.person || !r.personName || sameName(want.person, r.personName))
        );
        count(reminders, found);
        if (!found) missed = true;
      }
      const blob = JSON.stringify({ items: result.items, reminders: result.suggestedReminders });
      for (const word of c.expect.forbidden ?? []) {
        if (mentions(blob, word)) {
          forbiddenHits += 1;
          missed = true;
        }
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} capture/${c.id} — ${cards.length} card(s)`);
    } catch (err) {
      misses.push(c.id);
      count(people, false);
      log(`  FAIL capture/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      personRecall: rate(people),
      personPrecision: rate(precision),
      fieldAccuracy: rate(fields),
      opportunityRecall: rate(opportunities),
      referralRecall: rate(referrals),
      reminderRecall: rate(reminders),
      phantomParticipants,
      forbiddenHits,
    },
  };
}

/* ---------------------------------------------------------------------- recruiter ----- */

export async function runRecruiterTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<RecruiterEvalFixture>("ai-recruiter-eval.json").cases.slice(0, limit);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const details = tally();
  const misses: string[] = [];
  const latenciesMs: number[] = [];
  // With `--decisions jev`, the gate runs in front of the LLM exactly as the scan runs it.
  const jev = await recordingDecider(userId);
  const gatePairs: Array<{ p: number; label: boolean }> = [];
  let ruledOut = 0;
  let wrongRuleOuts = 0;

  for (const c of cases) {
    try {
      const gateSeen = jev?.seen.get("recruiter.gate")?.length ?? 0;
      const result = await timed(latenciesMs, () =>
        classifyRecruiterSender(userId, {
          senderName: c.senderName,
          senderEmail: c.senderEmail,
          firmGuess: c.firmGuess,
          messages: c.messages.map((m, i) => ({
            id: `${c.id}-${i}`,
            threadId: c.id,
            from: `${c.senderName} <${c.senderEmail}>`,
            to: "me@example.com",
            subject: m.subject,
            snippet: m.body.slice(0, 120),
            internalDate: Date.parse(m.date),
            listUnsubscribe: "",
            listId: "",
            precedence: "",
            body: m.body,
          })),
        }, { decider: jev?.decider ?? null })
      );
      const p = yesProbability(jev?.seen.get("recruiter.gate")?.[gateSeen]);
      if (p !== undefined) gatePairs.push({ p, label: c.expect.isRecruiter });
      if (result === RULED_OUT_VERDICT) {
        ruledOut += 1;
        if (c.expect.isRecruiter) wrongRuleOuts += 1;
      }
      // Production keeps a sender only above the confidence floor, so the eval does too.
      const said = result.isRecruiter && result.confidence >= RECRUITER_CONFIDENCE_FLOOR;
      const want = c.expect.isRecruiter;
      if (said && want) tp += 1;
      else if (said && !want) fp += 1;
      else if (!said && want) fn += 1;
      else tn += 1;
      let missed = said !== want;
      if (said && want) {
        for (const company of c.expect.companies ?? []) {
          const ok = result.companiesMentioned.some((m) => sameField(company, m)) || sameField(company, result.firm);
          count(details, ok);
          missed ||= !ok;
        }
        for (const role of c.expect.roles ?? []) {
          const ok = result.rolesDiscussed.some((r) => sameField(role, r));
          count(details, ok);
          missed ||= !ok;
        }
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} recruiter/${c.id} — said ${said ? "recruiter" : "not"} (${result.confidence.toFixed(2)})`);
    } catch (err) {
      misses.push(c.id);
      if (c.expect.isRecruiter) fn += 1;
      else tn += 1;
      log(`  FAIL recruiter/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: tp + fn === 0 ? null : tp / (tp + fn),
      accuracy: cases.length === 0 ? null : (tp + tn) / cases.length,
      detailRecall: rate(details),
      // Jev runs only: the share of senders settled without an LLM call, and how many of
      // them were real recruiters (must be 0 — a wrong rule-out is a recruiter lost).
      gateSkipped: jev && cases.length ? ruledOut / cases.length : null,
      gateWrongSkips: jev ? wrongRuleOuts : null,
    },
    ...(jev ? { calibration: { "recruiter.gate": calibrationBins(gatePairs) } } : {}),
  };
}

/* ---------------------------------------------------------------------- duplicates --- */

const subjectOf = (id: string, c: EvalCard) => ({
  id,
  fullName: c.fullName,
  email: c.email ?? null,
  linkedinUrl: null,
  xHandle: null,
  company: c.company ?? null,
  title: c.title ?? null,
});

/**
 * "Same person?" over card pairs (decisions/duplicates.ts), scored where it matters:
 *  - wrongMerges: different people that would merge automatically — today, every pair the
 *    rules score at or above 0.85; with Jev, those it does not veto;
 *  - lostMerges: the same person, which the rules would merge, vetoed (a veto's cost);
 *  - pairAccuracy: the engine's P(same) ≥ 0.5 against the label, for the review ranking.
 * Engines: Jev with `--decisions jev`, else the person's own model with an LLM key, else the
 * rules alone (the baseline: pairAccuracy is then null).
 */
export async function runDuplicatesTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const own = privateLabels<DuplicatesEvalFixture>("duplicates.json")?.pairs ?? [];
  const pairs = [
    ...fixture<DuplicatesEvalFixture>("ai-duplicates-eval.json").pairs,
    ...own.map((p) => ({ ...p, id: `own-${p.id}` })),
  ].slice(0, limit);
  const engines = await openEngines(userId, { llm: true });
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  let wrongMergesRules = 0;
  let wrongMerges = 0;
  let lostMerges = 0;
  let answered = 0;
  let right = 0;
  const bins: Array<{ p: number; label: boolean }> = [];

  for (const pair of pairs) {
    const index = buildDuplicateIndex([subjectOf("b", pair.b)]);
    const tier = findDuplicateCandidatesIndexed(index, { fullName: pair.a.fullName, email: pair.a.email, company: pair.a.company, title: pair.a.title })[0];
    const rulesMerge = Boolean(tier && tier.confidence >= DUPLICATE_MERGE_CONFIDENCE);
    const [answer] = await timed(latenciesMs, () =>
      samePersonProbabilities(engines, [[personCard(pair.a), personCard(pair.b)]], { engines: ["jev", "llm"], budgetMs: 20_000 })
    );
    const p = answer && answer.engine !== "rules" ? answer.answer.probability : null;
    const vetoed = answer?.engine === "jev" && p !== null && p <= DUPLICATE_TUNING.jev.rejectAtOrBelow;
    const merges = rulesMerge && !vetoed;
    if (rulesMerge && !pair.same) wrongMergesRules += 1;
    if (merges && !pair.same) wrongMerges += 1;
    if (rulesMerge && pair.same && vetoed) lostMerges += 1;
    if (p !== null) {
      answered += 1;
      if (p >= 0.5 === pair.same) right += 1;
      bins.push({ p, label: pair.same });
    }
    const bad = (merges && !pair.same) || (rulesMerge && pair.same && vetoed) || (p !== null && p >= 0.5 !== pair.same);
    if (bad) misses.push(pair.id);
    log(`  ${bad ? "MISS" : "ok  "} duplicates/${pair.id} [${answer?.engine ?? "rules"}] same=${pair.same} rules=${tier ? tier.confidence.toFixed(2) : "—"}${p === null ? "" : ` P=${p.toFixed(2)}`}${vetoed ? " VETO" : ""}`);
  }

  return {
    cases: pairs.length,
    misses,
    latenciesMs,
    metrics: {
      wrongMergesRules,
      wrongMerges,
      lostMerges,
      pairAccuracy: answered ? right / answered : null,
    },
    ...(bins.length ? { calibration: { "duplicates.same_person": calibrationBins(bins) } } : {}),
  };
}

/* ------------------------------------------------------------------------ mentions --- */

/**
 * Which contact a name in a note means (decisions/capture.ts), through the production path:
 * the rules (`resolveMentions`) and then `decideMentions` over the candidates as contacts.
 *  - outcomeAccuracy: what would be saved (a link, or none) against the label;
 *  - wrongLinks: links to the wrong contact, or where the label says none;
 *  - pickAccuracy: the engine's raw pick on the AMBIGUOUS cases — what an `act` threshold
 *    would let it link; reported so that threshold can be judged, not used today.
 */
export async function runMentionsTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const own = privateLabels<MentionsEvalFixture>("mentions.json")?.cases ?? [];
  const cases = [
    ...fixture<MentionsEvalFixture>("ai-mentions-eval.json").cases,
    ...own.map((c) => ({ ...c, id: `own-${c.id}` })),
  ].slice(0, limit);
  const engines = await openEngines(userId, { llm: true });
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  let outcomeRight = 0;
  let wrongLinks = 0;
  let picks = 0;
  let picksRight = 0;
  // Jev's confidence in its pick against whether the pick was right — the bins an `act`
  // threshold for linking ambiguous mentions would be read off.
  const pickBins: Array<{ p: number; label: boolean }> = [];

  for (const c of cases) {
    const subjects = c.candidates.map((card, i) => subjectOf(`c${i}`, card));
    const ruled = resolveMentions(subjects, [{ name: c.mention, context: c.sentence, nearPerson: c.nearPerson ?? null }]);
    const decided = await timed(latenciesMs, () =>
      decideMentions(engines, { ...ruled, subjects, corpus: c.sentence })
    );
    const linked = decided.resolved[0]?.contactId ?? null;
    const outcome = linked === null ? "none" : Number(linked.slice(1));
    if (outcome === c.expect) outcomeRight += 1;
    else if (outcome !== "none") wrongLinks += 1;

    // The engine's raw pick on the ambiguous ones, for judging an `act` threshold later.
    let pick: number | "none" | null = null;
    if (c.candidates.length > 1) {
      const r = await whichContact(engines, { text: c.mention, context: c.sentence, nearPerson: c.nearPerson ?? null }, c.candidates, c.sentence);
      if (r) {
        pick = r.choice;
        picks += 1;
        if (r.choice === c.expect) picksRight += 1;
        if (r.engine === "jev") pickBins.push({ p: r.p, label: r.choice === c.expect });
      }
    }
    const wrong = outcome !== c.expect;
    if (wrong) misses.push(c.id);
    log(`  ${wrong ? "MISS" : "ok  "} mentions/${c.id} → ${outcome} (want ${c.expect})${pick === null ? "" : ` pick ${pick}`}`);
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      outcomeAccuracy: cases.length ? outcomeRight / cases.length : null,
      wrongLinks,
      pickAccuracy: picks ? picksRight / picks : null,
    },
    ...(pickBins.length ? { calibration: { "mentions.resolve": calibrationBins(pickBins) } } : {}),
  };
}

/* ------------------------------------------------------------------------ calendar --- */

/**
 * Which calendar events become contacts and logged meetings (decisions/calendar.ts), through
 * `decideCalendarEvents` — the rules, then Jev's veto. Also Jev's raw read on EVERY event
 * (touch = P(one_on_one) + P(networking)), for the bins a future `act` would be read off.
 */
export async function runCalendarTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const fx = fixture<CalendarEvalFixture>("ai-calendar-eval.json");
  const cases = fx.events.slice(0, limit);
  const engines = await openEngines(userId);
  const start = new Date("2026-08-04T15:00:00Z");
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  let right = 0;
  let falseKeeps = 0;
  let lostKeeps = 0;
  let rulesRight = 0;
  const bins: Array<{ p: number; label: boolean }> = [];

  const events: ParsedCalendarEvent[] = cases.map((e) => ({
    uid: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start,
    end: new Date(start.getTime() + e.minutes * 60_000),
    attendees: e.attendees,
    organizer: e.organizer ?? null,
    selfResponse: e.selfResponse ?? null,
  }));
  const { decided } = await timed(latenciesMs, () => decideCalendarEvents(engines, events, [fx.self]));
  const raw = engines.jev
    ? await decideEach({ jev: engines.jev, llm: null }, { engines: ["jev"], budgetMs: 30_000 }, {
        operation: "calendar.kind",
        items: events.map((e) => calendarEventState(e, [fx.self])),
        chunkSize: 6,
        concurrency: 3,
        state: (chunk) => ({ events: Object.fromEntries(chunk.map(({ key, item }) => [key, item])) }),
        question: (key) => ({ ...calendarKindQuestion, instructions: `What kind of calendar entry is \`events.${key}\`?` }),
      })
    : [];

  cases.forEach((c, i) => {
    const keep = decided[i].classification.keep;
    const rulesKeep = classifyCalendarEvent(events[i], [fx.self]).keep;
    if (rulesKeep === c.keep) rulesRight += 1;
    if (keep === c.keep) right += 1;
    else if (keep) falseKeeps += 1;
    else lostKeeps += 1;
    const r = raw[i];
    const touch = r && r.engine === "jev" ? (r.answer.probabilities.one_on_one ?? 0) + (r.answer.probabilities.networking ?? 0) : null;
    if (touch !== null) bins.push({ p: Math.min(1, touch), label: c.keep });
    if (keep !== c.keep) misses.push(c.id);
    log(`  ${keep === c.keep ? "ok  " : "MISS"} calendar/${c.id} keep=${keep} (rules ${rulesKeep}, want ${c.keep})${touch === null ? "" : ` touch=${touch.toFixed(2)}`} [${decided[i].by}]`);
  });

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      keepAccuracy: cases.length ? right / cases.length : null,
      rulesKeepAccuracy: cases.length ? rulesRight / cases.length : null,
      falseKeeps,
      lostKeeps,
    },
    ...(bins.length ? { calibration: { "calendar.kind": calibrationBins(bins) } } : {}),
  };
}

/* ------------------------------------------------------------------ capture checks --- */

/**
 * The capture checks (decisions/capture.ts `decideCaptureChecks`) on their own fixture:
 * referral overrides, tag mapping, and — measured raw, because it ships disabled — presence.
 */
export async function runCaptureChecksTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const fx = fixture<CaptureChecksEvalFixture>("ai-capture-checks-eval.json");
  const engines = await openEngines(userId);
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  const person = (tags: string[], opportunities: BulkNotePersonPreview["opportunities"]) =>
    ({ parsed: { name: "x", tags }, opportunities }) as unknown as BulkNotePersonPreview;

  // Referral: the language test decides; with Jev, a confident "no" reverts it.
  let refRight = 0;
  let wrongReferrals = 0;
  for (const c of fx.referrals.slice(0, limit)) {
    const rules = looksLikeReferral(c.label, c.sentence);
    const item = person([], [
      { kind: rules ? "referral" : "other", label: c.label, direction: null, sourceExcerpt: c.sentence, rawDatePhrase: null, confidenceScore: 50, dueDateIso: null, ...(rules ? { overriddenKind: "other" as const } : {}) },
    ]);
    await timed(latenciesMs, () => decideCaptureChecks(engines, { items: [item], corpus: c.sentence, existingTags: [] }));
    const said = item.opportunities[0].kind === "referral";
    if (said === c.referral) refRight += 1;
    else if (said) wrongReferrals += 1;
    if (said !== c.referral) misses.push(c.id);
    log(`  ${said === c.referral ? "ok  " : "MISS"} capture-checks/${c.id} referral=${said} (rules ${rules}, want ${c.referral})`);
  }

  // Tags: exact (case-insensitive) match is the rule; Jev maps near-synonyms.
  let tagRight = 0;
  for (const c of fx.tags.slice(0, limit)) {
    const item = person([c.proposed], []);
    await decideCaptureChecks(engines, { items: [item], corpus: "", existingTags: c.existing });
    const written = item.parsed.tags?.[0] ?? c.proposed;
    const got = c.existing.includes(written) ? written : "keep_new";
    const exact = c.existing.find((t) => t.toLowerCase() === c.proposed.toLowerCase());
    const final = exact ?? got;
    if (final === c.expect) tagRight += 1;
    else misses.push(c.id);
    log(`  ${final === c.expect ? "ok  " : "MISS"} capture-checks/${c.id} "${c.proposed}" → ${final} (want ${c.expect})`);
  }

  // Presence, raw (it acts only when `presenceAct` is set): Jev's 3-way read per name.
  let presRight = 0;
  let presAsked = 0;
  let inventedCaught = 0;
  let invented = 0;
  for (const c of fx.presence.slice(0, limit)) {
    const names = Object.keys(c.people);
    const keys = names.map((_, i) => `c${String(i + 1).padStart(2, "0")}`);
    const r = engines.jev
      ? await decide({ jev: engines.jev, llm: null }, { engines: ["jev"], budgetMs: 10_000 }, {
          operation: "capture.checks",
          state: { note: c.note, people: Object.fromEntries(names.map((n, i) => [keys[i], n])) },
          questions: Object.fromEntries(keys.map((k) => [k, presenceQuestion(k)])),
        })
      : null;
    names.forEach((name, i) => {
      const want = c.people[name];
      // The rule fallback: a name none of whose words appear in the note is invented.
      const ruleInvented = !name.toLowerCase().split(/\s+/).some((w) => c.note.toLowerCase().includes(w));
      if (want === "not_in_note") {
        invented += 1;
        if (r?.engine === "jev" ? r.answers[keys[i]].choice === "not_in_note" : ruleInvented) inventedCaught += 1;
      }
      if (r?.engine === "jev") {
        presAsked += 1;
        if (r.answers[keys[i]].choice === want) presRight += 1;
      }
    });
    log(`  ok   capture-checks/${c.id} presence ${r?.engine === "jev" ? names.map((n, i) => `${n}=${r.answers[keys[i]].choice}`).join(", ") : "(rules)"}`);
  }

  return {
    cases: fx.referrals.length + fx.tags.length + fx.presence.length,
    misses,
    latenciesMs,
    metrics: {
      referralAccuracy: fx.referrals.length ? refRight / Math.min(fx.referrals.length, limit ?? Infinity) : null,
      wrongReferrals,
      tagAccuracy: fx.tags.length ? tagRight / Math.min(fx.tags.length, limit ?? Infinity) : null,
      presenceAccuracy: presAsked ? presRight / presAsked : null,
      inventedRecall: invented ? inventedCaught / invented : null,
      presenceAct: CAPTURE_CHECK_TUNING.presenceAct,
    },
  };
}

/* ----------------------------------------------------------------------- skip-gates --- */

/**
 * The five skip-gates (decisions/gates.ts): a Jev yes/no in front of a chat-model call that
 * usually finds nothing. Every case carries what the gate SHOULD say, and the two numbers
 * that matter pull against each other:
 *
 *  - `wrongSkips` — a call skipped that had something to find. Gated at zero: the output is
 *    simply missing afterwards, and nothing downstream notices.
 *  - `savedShare` — of the cases with nothing to find, how many were skipped. This is the
 *    whole point of the gate; at zero it costs a decision call and saves nothing.
 *
 * Also prints, per gate, the highest threshold that still makes no wrong skip on this
 * fixture — the number `SKIP_GATE_TUNING.skipAtOrBelow` should be tuned toward, with room
 * left for Jev's run-to-run drift. Without `--decisions jev` nothing is skipped, which is
 * exactly what the app does without a key, so the run is a (trivially perfect) baseline.
 */
export async function runSkipGatesTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const fx = fixture<SkipGatesEvalFixture>("ai-skip-gates-eval.json");
  const engines = await openEngines(userId);
  const cases = fx.cases.slice(0, limit);
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  const bins: Array<{ p: number; label: boolean }> = [];

  let wrongSkips = 0;
  let right = 0;
  let saveable = 0;
  let saved = 0;
  /** Per gate: the lowest probability seen on a case that must NOT be skipped. */
  const ceiling: Record<string, number> = {};
  const perGate: Record<string, { right: number; n: number }> = {};

  for (const c of cases) {
    const p = await timed(latenciesMs, () => gateProbability(engines, c.gate, c.state));
    const at = SKIP_GATE_TUNING.skipAtOrBelow[c.gate];
    // What the app would do: an off gate never skips, however sure the answer is.
    const skipped = p !== null && at !== null && p <= at;
    if (p !== null) bins.push({ p, label: !c.skip });
    if (!c.skip && p !== null) ceiling[c.gate] = Math.min(ceiling[c.gate] ?? 1, p);
    if (c.skip) {
      saveable += 1;
      if (skipped) saved += 1;
    } else if (skipped) {
      wrongSkips += 1;
    }
    const ok = skipped === c.skip;
    if (ok) right += 1;
    else misses.push(c.id);
    const g = (perGate[c.gate] ??= { right: 0, n: 0 });
    g.n += 1;
    if (ok) g.right += 1;
    log(
      `  ${ok ? "ok  " : "MISS"} skip-gates/${c.id} skip=${skipped} (want ${c.skip})` +
        `${p === null ? " [rules: nothing skipped]" : ` p(something)=${p.toFixed(2)}`}`
    );
  }

  for (const [g, v] of Object.entries(perGate)) {
    // The headroom on this fixture. A threshold at or just under it skips everything it
    // safely can; the shipped value sits below, for drift.
    const safe = ceiling[g];
    log(
      `  --   ${g}: ${v.right}/${v.n} correct, shipped threshold ${SKIP_GATE_TUNING.skipAtOrBelow[g as GateName] ?? "off"}` +
        `${safe === undefined ? "" : `, no wrong skip below ${safe.toFixed(2)}`}`
    );
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      gateAccuracy: cases.length ? right / cases.length : null,
      wrongSkips,
      savedShare: saveable ? saved / saveable : null,
    },
    ...(bins.length ? { calibration: { "skip-gates": calibrationBins(bins) } } : {}),
  };
}

/* -------------------------------------------------------------------- chat routing --- */

/** Companies whose names are also ordinary words — the roster traps — plus two plain ones. */
const ROUTING_COMPANIES = ["Stripe", "Ramp", "Notion", "Square", "Block", "Figma"];

/**
 * How chat questions are routed (decisions/chat-route.ts), end to end through the same
 * function the chat path calls. What answers depends on the run:
 *  - `--decisions jev` → Jev;
 *  - an LLM key and no `--decisions` → the question parser's intent flags;
 *  - neither → the keyword rules (the baseline).
 * Rosters go through `findOrgRosters` over a few seeded contacts, then the roster gate.
 * No chat answer is generated, so a Jev or rules run needs no LLM key.
 */
export async function runChatRoutingTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<ChatRoutingEvalFixture>("ai-chat-routing-eval.json").cases.slice(0, limit);
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, userId));
  for (const [i, company] of ROUTING_COMPANIES.entries()) {
    await db.insert(contacts).values([
      { userId, fullName: `Routing Person ${i}a`, company, title: "Engineer" },
      { userId, fullName: `Routing Person ${i}b`, company, title: "Product Manager" },
    ]);
  }
  const decider = await openDecider(userId);
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  let depthOk = 0;
  let tpR = 0;
  let fpR = 0;
  let fnR = 0;
  let attOk = 0;
  let tpA = 0;
  let fpA = 0;
  let recOk = 0;
  let rosterCases = 0;
  let rosterOk = 0;
  const engines = new Map<string, number>();

  for (const c of cases) {
    const priorTurns = c.priorTurns ?? [];
    const route = await timed(latenciesMs, () =>
      routeChatQuestion({
        decider,
        question: c.question,
        priorTurns,
        intent: async () => (await understandQuery(userId, c.question, [])).intent ?? null,
      })
    );
    engines.set(route.engine, (engines.get(route.engine) ?? 0) + 1);
    const matched = await findOrgRosters(userId, c.question).catch(() => []);
    const { rosters } = await gateRosters(decider, c.question, matched);

    const research = route.depth.depth === "research";
    const wantResearch = c.expect.depth === "research";
    if (research === wantResearch) depthOk += 1;
    if (research && wantResearch) tpR += 1;
    else if (research && !wantResearch) fpR += 1;
    else if (!research && wantResearch) fnR += 1;
    if (route.attention === c.expect.attention) attOk += 1;
    if (route.attention && c.expect.attention) tpA += 1;
    if (route.attention && !c.expect.attention) fpA += 1;
    if (route.recruiters === c.expect.recruiters) recOk += 1;

    const got = rosters.map((r) => r.name).sort().join(",");
    const want = [...c.expect.roster].sort().join(",");
    const rosterCase = matched.length > 0 || c.expect.roster.length > 0;
    if (rosterCase) {
      rosterCases += 1;
      if (got === want) rosterOk += 1;
    }

    const wrong: string[] = [];
    if (research !== wantResearch) wrong.push(`depth ${route.depth.depth} (${route.depth.reason})`);
    if (route.attention !== c.expect.attention) wrong.push(`attention ${route.attention}`);
    if (route.recruiters !== c.expect.recruiters) wrong.push(`recruiters ${route.recruiters}`);
    if (rosterCase && got !== want) wrong.push(`roster [${got}]`);
    if (wrong.length) misses.push(c.id);
    log(`  ${wrong.length ? "MISS" : "ok  "} routing/${c.id} [${route.engine}]${wrong.length ? ` — ${wrong.join("; ")}` : ""}`);
  }
  await db.delete(contacts).where(eq(contacts.userId, userId));
  log(`  engines: ${[...engines].map(([k, v]) => `${k} ${v}`).join(", ")}`);

  const attPositives = cases.filter((c) => c.expect.attention).length;
  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      depthAccuracy: cases.length ? depthOk / cases.length : null,
      researchPrecision: tpR + fpR === 0 ? null : tpR / (tpR + fpR),
      researchRecall: tpR + fnR === 0 ? null : tpR / (tpR + fnR),
      attentionAccuracy: cases.length ? attOk / cases.length : null,
      attentionPrecision: tpA + fpA === 0 ? null : tpA / (tpA + fpA),
      attentionRecall: attPositives ? tpA / attPositives : null,
      recruiterAccuracy: cases.length ? recOk / cases.length : null,
      rosterAccuracy: rosterCases ? rosterOk / rosterCases : null,
    },
  };
}

/* ------------------------------------------------------------------ recruiter gate --- */

/**
 * The gate alone, on the full messages the LLM would read: which senders it settles without
 * an LLM call, and whether any of them was a real recruiter. The `recruiter` task measures
 * the same gate end to end with the LLM behind it; this one needs no LLM key, so the safety
 * question — does it ever rule out a recruiter? — can be answered on a TypeSafe key alone.
 * Without a decider it rules nobody out, and its metrics are null.
 */
export async function runRecruiterGateTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<RecruiterEvalFixture>("ai-recruiter-eval.json").cases.slice(0, limit);
  const jev = await recordingDecider(userId);
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  const pairs: Array<{ p: number; label: boolean }> = [];
  let ruledOut = 0;
  let wrong = 0;
  let negativesRuledOut = 0;
  const negatives = cases.filter((c) => !c.expect.isRecruiter).length;

  for (const c of cases) {
    if (!jev) break;
    const seen = jev.seen.get("recruiter.gate")?.length ?? 0;
    const out = await timed(latenciesMs, () =>
      rulesOutRecruiter(jev.decider, {
        senderName: c.senderName,
        senderEmail: c.senderEmail,
        firmGuess: c.firmGuess,
        messages: c.messages.map((m) => ({ subject: m.subject, snippet: m.body.slice(0, 120), body: m.body, internalDate: Date.parse(m.date) })),
      })
    );
    const p = yesProbability(jev.seen.get("recruiter.gate")?.[seen]);
    if (p !== undefined) pairs.push({ p, label: c.expect.isRecruiter });
    if (out) {
      ruledOut += 1;
      if (c.expect.isRecruiter) wrong += 1;
      else negativesRuledOut += 1;
    }
    const bad = out && c.expect.isRecruiter;
    if (bad) misses.push(c.id);
    log(`  ${bad ? "MISS" : "ok  "} gate/${c.id} (${c.kind}) — ${out ? "ruled out" : "to the LLM"}${p === undefined ? "" : ` (P=${p.toFixed(2)})`}`);
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      // The LLM calls it saves, as a share of all senders.
      gateSkipped: jev && cases.length ? ruledOut / cases.length : null,
      // …and as a share of the senders that were not recruiters: the most it could save.
      negativesRuledOut: jev && negatives ? negativesRuledOut / negatives : null,
      // Real recruiters it ruled out. Must be 0.
      gateWrongSkips: jev ? wrong : null,
    },
    ...(jev ? { calibration: { "recruiter.gate": calibrationBins(pairs) } } : {}),
  };
}

/* -------------------------------------------------------------- recruiter prefilter --- */

/** Roughly what Gmail and Graph hand back as a snippet: the opening of the body. */
const SNIPPET_CHARS = 200;

/**
 * The scan's DISCOVERY step on the recruiter fixture: which senders become candidates at all,
 * judged from the From line, subject and snippet — the only things discovery has. Without a
 * decider this measures the keyword prefilter alone (the baseline); with `--decisions jev` it
 * measures keywords plus Jev, through the same `admitRecruiterCandidates` the runners call.
 * A sender it drops is never looked at again, so recall is the number that matters.
 */
export async function runRecruiterPrefilterTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<RecruiterEvalFixture>("ai-recruiter-eval.json").cases.slice(0, limit);
  const jev = await recordingDecider(userId);
  const latenciesMs: number[] = [];
  const misses: string[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let keywordTp = 0;
  const pairs: Array<{ p: number; label: boolean }> = [];

  for (const c of cases) {
    const first = c.messages[0];
    const line = {
      id: c.id,
      from: `${c.senderName} <${c.senderEmail}>`,
      subject: first?.subject ?? "",
      snippet: (first?.body ?? "").replace(/\s+/g, " ").slice(0, SNIPPET_CHARS),
    };
    const seen = jev?.seen.get("recruiter.prefilter")?.length ?? 0;
    const admitted = await timed(latenciesMs, () =>
      admitRecruiterCandidates([line], jev?.decider ?? null, { alreadyCandidate: () => false })
    );
    const p = yesProbability(jev?.seen.get("recruiter.prefilter")?.[seen]);
    if (p !== undefined) pairs.push({ p, label: c.expect.isRecruiter });

    const said = admitted.has(c.id);
    const want = c.expect.isRecruiter;
    if (looksLikeRecruiter(line) && want) keywordTp += 1;
    if (said && want) tp += 1;
    else if (said && !want) fp += 1;
    else if (!said && want) fn += 1;
    const missed = said !== want;
    if (missed) misses.push(c.id);
    log(`  ${missed ? "MISS" : "ok  "} prefilter/${c.id} (${c.kind}) — ${said ? "admitted" : "dropped"}${p === undefined ? "" : ` (P=${p.toFixed(2)})`}`);
  }

  const positives = tp + fn;
  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      recall: positives === 0 ? null : tp / positives,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      // The keywords alone, on the same text — the number Jev is there to beat.
      keywordRecall: positives === 0 ? null : keywordTp / positives,
    },
    ...(jev ? { calibration: { "recruiter.prefilter": calibrationBins(pairs) } } : {}),
  };
}

/* ---------------------------------------------------------------------- extension ----- */

const field = (value: string | null) =>
  value ? { value, source: "eval", confidence: "medium" as const } : null;

export async function runExtensionTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<ExtensionEvalFixture>("ai-extension-eval.json").cases.slice(0, limit);
  const fields = tally();
  const nulls = tally();
  let forbiddenHits = 0;
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    const page: PageContext = {
      schemaVersion: 1,
      site: "linkedin",
      adapterVersion: "eval",
      kind: "person",
      url: `https://www.linkedin.com/in/${c.id}/`,
      sourceUrl: `https://www.linkedin.com/in/${c.id}/`,
      capturedAt: new Date().toISOString(),
      identity: {
        name: field(c.identityName),
        headline: null,
        title: null,
        company: null,
        location: null,
        school: null,
        email: null,
        handle: field(c.id),
        profileUrl: field(`https://www.linkedin.com/in/${c.id}/`),
        photoUrl: null,
      },
      text: { blob: c.pageText, truncated: false, charCount: c.pageText.length, fromSelection: false },
      warnings: [],
    };
    try {
      const parsed = await timed(latenciesMs, () => parseProfileFields(userId, page));
      if (parsed.degraded) throw new Error(`degraded: ${parsed.degradedReason ?? "unknown"}`);
      let missed = false;
      const pairs: Array<[string | undefined, string | null]> = [
        [c.expect.fullName, parsed.fullName],
        [c.expect.title, parsed.title],
        [c.expect.company, parsed.company],
        [c.expect.location, parsed.location],
        [c.expect.school, parsed.school],
      ];
      for (const [want, got] of pairs) {
        if (!want) continue;
        const ok = sameField(want, got);
        count(fields, ok);
        missed ||= !ok;
      }
      for (const key of c.expect.mustBeNull ?? []) {
        const ok = !parsed[key];
        count(nulls, ok);
        missed ||= !ok;
      }
      const blob = JSON.stringify(parsed);
      for (const word of c.expect.forbidden ?? []) {
        if (mentions(blob, word)) {
          forbiddenHits += 1;
          missed = true;
        }
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} extension/${c.id}`);
    } catch (err) {
      misses.push(c.id);
      count(fields, false);
      log(`  FAIL extension/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: { fieldAccuracy: rate(fields), nullAccuracy: rate(nulls), forbiddenHits },
  };
}

/* ---------------------------------------------------------------------------- ocr ----- */

/**
 * A photographed notebook page, drawn from the fixture's lines. Handwriting uses the macOS
 * handwriting faces, so on a machine without them it degrades to print — the report prints
 * which font rendered, and a baseline and candidate always render on the same machine.
 */
async function renderNotePage(lines: string[], style: "print" | "hand"): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const font = style === "hand" ? "Bradley Hand, Noteworthy, Marker Felt, cursive" : "Helvetica, Arial, sans-serif";
  const lineHeight = style === "hand" ? 72 : 60;
  const width = 1400;
  const height = 140 + lines.length * lineHeight;
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = lines
    .map(
      (line, i) =>
        // A little drift per line, the way a hand never writes on the rule.
        `<text x="${90 + ((i * 7) % 13)}" y="${110 + i * lineHeight}" transform="rotate(${style === "hand" ? ((i % 3) - 1) * 0.6 : 0} 700 ${110 + i * lineHeight})">${escape(line)}</text>`
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fbf8ef"/>
    ${lines.map((_, i) => `<line x1="60" x2="${width - 60}" y1="${122 + i * lineHeight}" y2="${122 + i * lineHeight}" stroke="#c9d6e8" stroke-width="2"/>`).join("")}
    <g font-family="${font}" font-size="${style === "hand" ? 46 : 40}" fill="#1f2a44">${text}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

export async function runOcrTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<OcrEvalFixture>("ai-ocr-eval.json").cases.slice(0, limit);
  const names = tally();
  const cers: number[] = [];
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const image = await renderNotePage(c.lines, c.style);
      const [page] = await timed(latenciesMs, () =>
        transcribeImagePages(userId, [{ mimeType: "image/jpeg", base64: image.toString("base64") }])
      );
      if (!page?.ok) throw new Error(`page not read: ${page?.error ?? "no result"}`);
      const text = page.text;
      const cer = characterErrorRate(c.lines.join("\n"), text);
      cers.push(cer);
      let missed = false;
      for (const name of c.names) {
        const ok = mentions(text, name);
        count(names, ok);
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} ocr/${c.id} (${c.style}) — CER ${(cer * 100).toFixed(1)}%`);
    } catch (err) {
      misses.push(c.id);
      for (let i = 0; i < c.names.length; i++) count(names, false);
      log(`  FAIL ocr/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { cases: cases.length, misses, latenciesMs, metrics: { nameRecall: rate(names), cer: mean(cers) } };
}

/* --------------------------------------------------------------------- transcribe ----- */

/** Speaks the script with macOS `say` as 16 kHz mono WAV — the recorder's own format. */
function speak(script: string): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), "orbit-eval-say-"));
  const file = join(dir, "memo.wav");
  try {
    execFileSync("say", ["-o", file, "--file-format=WAVE", "--data-format=LEI16@16000", script], {
      stdio: "ignore",
    });
    return readFileSync(file);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runTranscribeTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<TranscribeEvalFixture>("ai-transcribe-eval.json").cases.slice(0, limit);
  const names = tally();
  const wers: number[] = [];
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    const audio = speak(c.script);
    if (!audio) {
      log(`  skip transcribe/${c.id} — macOS \`say\` is not available here`);
      continue;
    }
    try {
      const result = await timed(latenciesMs, () =>
        transcribeAudioWithAI(userId, { mimeType: "audio/wav", base64: audio.toString("base64"), filename: "memo.wav" })
      );
      const wer = wordErrorRate(c.script, result.text);
      wers.push(wer);
      let missed = false;
      for (const name of c.names) {
        const ok = mentions(result.text, name);
        count(names, ok);
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} transcribe/${c.id} (${result.engine}) — WER ${(wer * 100).toFixed(1)}%`);
    } catch (err) {
      misses.push(c.id);
      for (let i = 0; i < c.names.length; i++) count(names, false);
      log(`  FAIL transcribe/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { cases: cases.length, misses, latenciesMs, metrics: { nameRecall: rate(names), wer: mean(wers) } };
}

/* --------------------------------------------------------------------------- chat ----- */

type SearchFixture = {
  contacts: Array<{
    email: string; fullName: string; company: string; title: string; school: string;
    industry: string; location: string; notes: string; tags: string[];
  }>;
};

/** Seeds `contact-search-eval.json`'s network for the eval user, embeddings included. */
async function seedNetwork(userId: string): Promise<Map<string, { id: string; fullName: string }>> {
  const network = fixture<SearchFixture>("contact-search-eval.json");
  const db = await getDb();
  const byEmail = new Map<string, { id: string; fullName: string }>();
  for (const c of network.contacts) {
    const [row] = await db
      .insert(contacts)
      .values({
        userId, fullName: c.fullName, company: c.company, title: c.title, school: c.school,
        industry: c.industry, location: c.location, notes: c.notes, email: c.email,
      })
      .returning();
    byEmail.set(c.email, { id: row.id, fullName: c.fullName });
    for (const name of c.tags) {
      let tag = await db.query.tags.findFirst({ where: and(eq(tags.userId, userId), eq(tags.name, name)) });
      if (!tag) [tag] = await db.insert(tags).values({ userId, name }).returning();
      await db.insert(contactTags).values({ contactId: row.id, tagId: tag.id });
    }
  }
  // The semantic arm needs vectors; without an embedding key the chat eval still runs on
  // the lexical arms, and says so.
  await rebuildContactEmbeddingsBatch(userId, [...byEmail.values()].map((c) => c.id)).catch((err) =>
    console.warn(`  (embeddings unavailable: ${err instanceof Error ? err.message : String(err)})`)
  );
  return byEmail;
}

export async function runChatTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<ChatEvalFixture>("ai-chat-eval.json").cases.slice(0, limit);
  const network = await seedNetwork(userId);
  const answered = tally();
  const retrieved = tally();
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const { ctx, result } = await timed(latenciesMs, async () => {
        const requestStartedAt = Date.now();
        const ctx = await prepareChatContext(userId, c.question, {});
        // The research round runs here as it does in production (`askNetwork`, the route), so
        // this task's cost and latency include it — and a routing change shows up in both.
        const { evidence } = await maybeGather(userId, ctx, { requestStartedAt });
        const result = await chatWithNetwork(
          userId,
          ctx.scopedQuestion,
          ctx.modelContacts,
          ctx.priorTurns,
          ctx.orgRosters,
          ctx.attention,
          ctx.modelRecruiters,
          ctx.focusProfile,
          ctx.attachedContext,
          ctx.goals,
          ctx.attentionLite,
          evidence
        );
        return { ctx, result };
      });
      const recommended = new Set(
        ((result.recommendations ?? []) as Array<{ contact_id?: string | null }>).map((r) => r.contact_id)
      );
      const shown = new Set(ctx.modelContacts.map((m) => m.id));
      let missed = false;
      for (const email of c.mustMention) {
        const person = network.get(email);
        if (!person) throw new Error(`fixture names ${email}, which contact-search-eval.json does not have`);
        const ok = mentions(result.answer ?? "", person.fullName) || recommended.has(person.id);
        count(answered, ok);
        count(retrieved, shown.has(person.id));
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      log(`  ${missed ? "MISS" : "ok  "} chat/${c.id}`);
    } catch (err) {
      misses.push(c.id);
      for (let i = 0; i < c.mustMention.length; i++) count(answered, false);
      log(`  FAIL chat/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: { mentionRecall: rate(answered), retrievalRecall: rate(retrieved) },
  };
}

/* ----------------------------------------------------------------------- research ----- */

/** Everything the research task seeds, removed — before it runs and after. */
async function clearResearchUser(userId: string) {
  const db = await getDb();
  await db.delete(memoryChunks).where(eq(memoryChunks.userId, userId));
  await db.delete(interactions).where(eq(interactions.userId, userId));
  await db.delete(chatMessages).where(eq(chatMessages.userId, userId));
  await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(tags).where(eq(tags.userId, userId));
}

/**
 * Whole answers to questions one retrieval cannot answer — the research step's job.
 *
 * Runs the production path end to end, in order: retrieval, the depth decision, the research
 * loop, the answer, the recommendation filter. Routing is scored the moment it is decided,
 * so a case whose answer then fails still says whether it went to the right path.
 *
 * Clears its user before AND after: the chat task seeds the same network into the same user,
 * and neither may see the other's rows when both run in one invocation.
 */
export async function runResearchTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<ResearchEvalFixture>("ai-research-eval.json").cases.slice(0, limit);
  await clearResearchUser(userId);
  const network = await seedNetwork(userId);
  await seedPassageNotes(
    userId,
    loadPassageFixture(FIXTURE_DIR),
    new Map([...network].map(([email, c]) => [email, c.id]))
  );
  // Passages embedded through the real drain, so the research step's search_notes has its
  // meaning arm. Without an embedding key it runs on words, and says so.
  await runEmbeddingBackfill(userId).catch((err) =>
    log(`  (passage embeddings unavailable: ${err instanceof Error ? err.message : String(err)})`)
  );
  const known = new Set([...network.values()].map((c) => c.id));

  const mentioned = tally();
  const said = tally();
  const routed = tally();
  let forbiddenHits = 0;
  let inventedContactIds = 0;
  let filteredRecommendations = 0;
  const lookups: number[] = [];
  const rounds: number[] = [];
  const misses: string[] = [];
  const latenciesMs: number[] = [];
  const db = await getDb();

  for (const c of cases) {
    let routedOk: boolean | null = null;
    try {
      let threadId: string | null = null;
      if (c.priorTurns?.length) {
        const [thread] = await db.insert(chatThreads).values({ userId }).returning();
        threadId = thread.id;
        for (const turn of c.priorTurns) {
          await db.insert(chatMessages).values({ threadId, userId, role: turn.role, content: turn.content });
        }
      }

      const { ctx, gathered, result } = await timed(latenciesMs, async () => {
        const ctx = await prepareChatContext(userId, c.question, { threadId });
        const gathered = await maybeGather(userId, ctx, { requestStartedAt: Date.now() });
        routedOk = gathered.depth.depth === c.expectDepth;
        const result = await chatWithNetwork(
          userId,
          ctx.scopedQuestion,
          ctx.modelContacts,
          ctx.priorTurns,
          ctx.orgRosters,
          ctx.attention,
          ctx.modelRecruiters,
          ctx.focusProfile,
          ctx.attachedContext,
          ctx.goals,
          ctx.attentionLite,
          gathered.evidence
        );
        return { ctx, gathered, result };
      });

      const raw = (result.recommendations ?? []) as Array<{ contact_id?: string | null } & Record<string, unknown>>;
      const kept = ctx.filterRecommendations(raw as never);
      const people = c.mustMention.map((email) => {
        const person = network.get(email);
        if (!person) throw new Error(`fixture names ${email}, which contact-search-eval.json does not have`);
        return person;
      });
      const score = scoreResearchAnswer({
        answer: result.answer ?? "",
        rawRecommendationIds: raw.map((r) => r.contact_id),
        keptRecommendationIds: kept.map((r) => r.contact_id),
        mustMention: people,
        mustSay: c.mustSay,
        forbidden: c.forbidden ?? [],
        knownContactIds: known,
      });

      score.mentioned.forEach((ok) => count(mentioned, ok));
      score.said.forEach((ok) => count(said, ok));
      forbiddenHits += score.forbiddenHits;
      inventedContactIds += score.inventedIds;
      filteredRecommendations += score.filteredOut;
      if (gathered.research) {
        lookups.push(gathered.research.lookups);
        rounds.push(gathered.research.rounds);
      }

      const missed =
        !routedOk ||
        score.mentioned.includes(false) ||
        score.said.includes(false) ||
        score.forbiddenHits > 0 ||
        score.inventedIds > 0;
      if (missed) misses.push(c.id);
      const research = gathered.research
        ? ` — ${gathered.research.lookups} lookup(s), ${gathered.research.rounds} round(s), stopped: ${gathered.research.stoppedBy}`
        : "";
      // Say WHAT missed. A bare MISS on a one-off run leaves nothing to go on: the first
      // baseline had one, and whether it was the person, the fact or the routing could only
      // be guessed at afterwards.
      const why = missed
        ? [
            !routedOk ? `routed ${gathered.depth.depth}, expected ${c.expectDepth}` : null,
            ...people.flatMap((p, i) => (score.mentioned[i] ? [] : [`did not name ${p.fullName}`])),
            ...c.mustSay.flatMap((f, i) => (score.said[i] ? [] : [`did not say "${f}"`])),
            score.forbiddenHits ? `${score.forbiddenHits} unsupported claim(s)` : null,
            score.inventedIds ? `${score.inventedIds} invented id(s)` : null,
          ]
            .filter(Boolean)
            .join("; ")
        : "";
      log(`  ${missed ? "MISS" : "ok  "} research/${c.id} [${gathered.depth.depth}]${research}${why ? ` — ${why}` : ""}`);
      if (missed) log(`       answer: ${(result.answer ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
    } catch (err) {
      misses.push(c.id);
      c.mustMention.forEach(() => count(mentioned, false));
      c.mustSay.forEach(() => count(said, false));
      log(`  FAIL research/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Scored even when the answer failed: routing is decided before any answer is written.
      if (routedOk !== null) count(routed, routedOk);
    }
  }

  await clearResearchUser(userId);
  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      mentionRecall: rate(mentioned),
      factRecall: rate(said),
      routingAccuracy: rate(routed),
      forbiddenHits,
      inventedContactIds,
      // Informational, not gated: what the filter caught, and what research cost in lookups.
      filteredRecommendations,
      meanLookups: mean(lookups),
      meanRounds: mean(rounds),
    },
  };
}

/* ------------------------------------------------------------------------- digest ----- */

export async function runDigestTask({ userId, limit, log }: RunOpts): Promise<TaskResult> {
  const cases = fixture<DigestEvalFixture>("ai-digest-eval.json").cases.slice(0, limit);
  const attendees = tally();
  const attendeePrecision = tally();
  const actions = tally();
  const misses: string[] = [];
  const latenciesMs: number[] = [];

  for (const c of cases) {
    try {
      const digest = await timed(latenciesMs, () =>
        analyzeMeetingTranscript(
          userId,
          {
            paragraphs: c.transcript,
            title: c.title,
            startedAtIso: "2026-09-15T15:00:00.000Z",
            userName: c.userName,
            attendees: c.calendarAttendees,
          },
          { complete: completeJson, parseJson: parseAiJson }
        )
      );
      const present = digest.participants.filter((p) => p.present && !sameName(c.userName, p.name));
      let missed = false;
      for (const name of c.expect.attendees) {
        const ok = present.some((p) => sameName(name, p.name));
        count(attendees, ok);
        missed ||= !ok;
      }
      for (const p of present) count(attendeePrecision, c.expect.attendees.some((name) => sameName(name, p.name)));
      for (const phrase of c.expect.actionItems) {
        const ok = digest.actionItems.some((a) => mentions(a.text, phrase));
        count(actions, ok);
        missed ||= !ok;
      }
      if (missed) misses.push(c.id);
      const chars = c.transcript.join("\n\n").length;
      log(`  ${missed ? "MISS" : "ok  "} digest/${c.id} (${chars.toLocaleString("en-US")} chars)`);
    } catch (err) {
      misses.push(c.id);
      count(attendees, false);
      log(`  FAIL digest/${c.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    cases: cases.length,
    misses,
    latenciesMs,
    metrics: {
      attendeeRecall: rate(attendees),
      attendeePrecision: rate(attendeePrecision),
      actionItemRecall: rate(actions),
    },
  };
}

export const TASKS: Record<TaskName, (opts: RunOpts) => Promise<TaskResult>> = {
  capture: runCaptureTask,
  recruiter: runRecruiterTask,
  "recruiter-prefilter": runRecruiterPrefilterTask,
  "recruiter-gate": runRecruiterGateTask,
  "chat-routing": runChatRoutingTask,
  duplicates: runDuplicatesTask,
  mentions: runMentionsTask,
  calendar: runCalendarTask,
  "capture-checks": runCaptureChecksTask,
  "skip-gates": runSkipGatesTask,
  extension: runExtensionTask,
  ocr: runOcrTask,
  transcribe: runTranscribeTask,
  chat: runChatTask,
  research: runResearchTask,
  digest: runDigestTask,
};
