import {
  resolveAiAccess,
  typesafeClient,
  type AiAccess,
  type DecisionGrant,
} from "@/lib/ai-access";
import type { DecisionOperationId } from "@/lib/ai-operations";
import { withAiResultCache } from "@/lib/ai-result-cache";
import type { SystemOneRequest, SystemOneResponse } from "@/lib/typesafe-api";
import { tokensFromJev, withUsage } from "@/lib/usage-events";

/**
 * JEV — TypeSafe's decision model, as Orbit uses it.
 *
 * An LLM writes; Jev only judges. It takes a `state` (text or JSON) and a map of typed
 * questions, and answers every question independently, in parallel, with a calibrated
 * probability — at about 100ms and $0.042 per million input tokens, output free. Three
 * question types:
 *
 *  - `noul`    yes/no → the probability of yes (no separate confidence; the probability IS it)
 *  - `choice`  one of up to 255 options you define → the pick, every option's probability,
 *              and a confidence (how concentrated the distribution is)
 *  - `score`   2–10 ordered levels → the probability-weighted level, its distribution, and a
 *              confidence
 *
 * What it cannot do: write text, extract a string, count, do date arithmetic, read images.
 * So it never replaces an extraction; it decides whether one is worth running, and ranks.
 *
 * THE INVARIANT: a decision is always optional. `openDecider` is null for an account with no
 * TypeSafe key (most of them), and `ask` returns null on a timeout, a 429, a malformed
 * answer, anything — never a throw. Every call site keeps the path it had before Jev and
 * takes it on null, so Jev can make a step cheaper or better, never make it fail.
 *
 * Questions and thresholds live in `catalog.ts`, not at call sites: they are tuned together
 * against one pinned model version (`JEV_MODEL`), and reviewed together.
 */

/* ------------------------------------------------------------------ questions -------- */

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type ChoiceQuestion<K extends string = string> = {
  type: "choice";
  instructions: string;
  criteria: Record<K, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  /** Ordered levels, lowest first. 2–10 of them. */
  criteria: readonly string[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type QuestionMap = Record<string, Question>;

export function noul(instructions: string, criteria?: NoulQuestion["criteria"]): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function choice<K extends string>(instructions: string, criteria: Record<K, string>): ChoiceQuestion<K> {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: string, levels: readonly string[]): ScoreQuestion {
  if (levels.length < 2 || levels.length > 10) {
    throw new Error(`A score question takes 2–10 levels, not ${levels.length}`);
  }
  return { type: "score", instructions, criteria: levels };
}

/* -------------------------------------------------------------------- answers -------- */

export type NoulAnswer = { type: "noul"; probability: number };

export type ChoiceAnswer<K extends string = string> = {
  type: "choice";
  choice: K;
  probabilities: Partial<Record<K, number>>;
  /** Null when TypeSafe sent none — never invented. */
  confidence: number | null;
};

export type ScoreAnswer = {
  type: "score";
  /** Probability-weighted level index, 0 … levels-1. Can land between levels. */
  score: number;
  /** `score` scaled to 0–1, so thresholds survive a change in the number of levels. */
  normalized: number;
  probabilities: Record<string, number>;
  confidence: number | null;
};

export type AnswerFor<Q> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

export type Answers<Q extends QuestionMap> = { [K in keyof Q]: AnswerFor<Q[K]> };

const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function probabilities(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) if (isProb(p)) out[k] = p;
  return out;
}

function parseOne(question: Question, raw: unknown): AnswerFor<Question> | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const confidence = isProb(a.confidence) ? a.confidence : null;

  if (question.type === "noul") {
    // TypeSafe's own API says `noul`; the AI SDK's adapter renames it `probability`. Accept
    // either, so a transport change cannot silently turn every answer into a null.
    const p = isProb(a.noul) ? a.noul : isProb(a.probability) ? a.probability : null;
    return p === null ? null : { type: "noul", probability: p };
  }

  if (question.type === "choice") {
    const pick = a.choice;
    if (typeof pick !== "string" || !Object.prototype.hasOwnProperty.call(question.criteria, pick)) return null;
    return { type: "choice", choice: pick, probabilities: probabilities(a.probabilities), confidence };
  }

  const top = question.criteria.length - 1;
  const s = a.score;
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > top) return null;
  return { type: "score", score: s, normalized: top > 0 ? s / top : 0, probabilities: probabilities(a.probabilities), confidence };
}

/**
 * Every question's answer, validated against the question that was asked — or null if any
 * one is missing or malformed. All-or-nothing on purpose: a call site acting on a partial
 * answer set would be acting on a question nobody answered.
 */
export function parseAnswers<Q extends QuestionMap>(questions: Q, response: SystemOneResponse | null | undefined): Answers<Q> | null {
  const answers = response?.answers;
  if (!answers || typeof answers !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    const parsed = parseOne(question, answers[key]);
    if (!parsed) return null;
    out[key] = parsed;
  }
  return out as Answers<Q>;
}

/* -------------------------------------------------------------------- asking --------- */

export type DecisionRequest<Q extends QuestionMap> = {
  operation: DecisionOperationId;
  state: SystemOneRequest["state"];
  questions: Q;
};

export type DecisionResult<Q extends QuestionMap> = {
  answers: Answers<Q>;
  /** The versioned model TypeSafe says answered — log it beside any threshold decision. */
  model: string;
};

export type AskOptions = {
  /** Hard ceiling. Past it the answer is null and the caller's fallback runs. */
  timeoutMs: number;
  /** The caller's own abort (a closed tab). */
  signal?: AbortSignal;
  /**
   * Replay an identical question set's answer for this many days (`ai_result_cache`). The
   * key covers the model, the state and every question, so any change asks again.
   */
  cacheDays?: number;
};

/** The one thing call sites hold. An interface so smoke tests can stand in a scripted one. */
export interface Decider {
  ask<Q extends QuestionMap>(request: DecisionRequest<Q>, opts: AskOptions): Promise<DecisionResult<Q> | null>;
}

async function callJev<Q extends QuestionMap>(
  userId: string,
  grant: DecisionGrant,
  request: DecisionRequest<Q>,
  opts: AskOptions,
): Promise<DecisionResult<Q> | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Aborting the request is the normal way out, but the deadline is also raced here, so a
  // transport that ignores its signal still cannot hold a caller past `timeoutMs`.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("decision timed out"));
    }, opts.timeoutMs);
  });
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const call = withUsage(
      {
        userId,
        operation: request.operation,
        provider: "typesafe",
        model: grant.model,
        kind: "decision",
        keyOwner: grant.keyOwner,
      },
      async (report) => {
        const res = await typesafeClient(grant).systemOne(
          {
            model: grant.model,
            state: request.state,
            questions: request.questions as unknown as SystemOneRequest["questions"],
          },
          { signal: controller.signal },
        );
        report(tokensFromJev(res));
        return res;
      },
      { cancelSignal: opts.signal },
    );
    call.catch(() => {}); // settles after the deadline wins; its failure is already recorded
    const response = await Promise.race([call, deadline]);
    const answers = parseAnswers(request.questions, response);
    if (!answers) return null;
    return { answers, model: typeof response.model === "string" ? response.model : grant.model };
  } catch {
    // The failure is already in `usage_events` (withUsage records it). The caller falls back.
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

class JevDecider implements Decider {
  constructor(
    private readonly userId: string,
    private readonly access: AiAccess,
  ) {}

  async ask<Q extends QuestionMap>(request: DecisionRequest<Q>, opts: AskOptions): Promise<DecisionResult<Q> | null> {
    const grant = this.access.decision(request.operation);
    if (!grant) return null;
    const run = () => callJev(this.userId, grant, request, opts);
    if (!opts.cacheDays) return run();
    try {
      return await withAiResultCache(
        this.userId,
        request.operation,
        { model: grant.model, state: request.state, questions: request.questions },
        run,
        // A null (failed) answer is never stored, so the next scan asks again.
        { ttlDays: opts.cacheDays, accept: (v) => v !== null },
      );
    } catch {
      return null;
    }
  }
}

/**
 * The account's decider, or null when it has no TypeSafe key (or `ORBIT_JEV=off`). One
 * account read, however many questions follow — open it once per scan or per chat turn.
 * Never throws: a failed account read is just "no decider", and the caller's old path runs.
 */
export async function openDecider(userId: string, access?: AiAccess): Promise<Decider | null> {
  try {
    const resolved = access ?? (await resolveAiAccess(userId));
    // Any operation id works for the probe; the real grant is minted per question set.
    if (!resolved.decision("chat.rerank.decide")) return null;
    return new JevDecider(userId, resolved);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- one per item ---------- */

/**
 * One question per item, `chunkSize` items to a call, `concurrency` calls at a time — the
 * shape of the prefilter (a question per sender) and the rerank (a score per candidate).
 *
 * Each chunk's items are filed under short keys (`c01`, `c02`, …) so a question can point at
 * its own item by field reference (`` `candidates.c07` ``), which is how TypeSafe asks
 * questions to be tied to one part of a shared state. Chunking trades cost for accuracy:
 * every question in a call reads the whole state, so one call is cheapest, while smaller
 * chunks mean fewer other items acting as distractors.
 *
 * The answer for item i is at index i, or null where its call failed. Never throws.
 */
export async function askPerItem<T, Q extends Question>(
  decider: Decider,
  args: {
    operation: DecisionOperationId;
    items: readonly T[];
    chunkSize: number;
    concurrency: number;
    /** The state for one chunk, from its items and the keys they are filed under. */
    state: (chunk: ReadonlyArray<{ key: string; item: T }>) => SystemOneRequest["state"];
    question: (key: string) => Q;
  },
  opts: AskOptions,
): Promise<Array<AnswerFor<Q> | null>> {
  const size = Math.max(1, Math.floor(args.chunkSize));
  const chunks: Array<Array<{ key: string; item: T; index: number }>> = [];
  for (let start = 0; start < args.items.length; start += size) {
    chunks.push(
      args.items.slice(start, start + size).map((item, i) => ({
        key: `c${String(i + 1).padStart(2, "0")}`,
        item,
        index: start + i,
      })),
    );
  }

  const out: Array<AnswerFor<Q> | null> = args.items.map(() => null);
  await mapPool(chunks, args.concurrency, async (chunk) => {
    const questions: Record<string, Q> = {};
    for (const { key } of chunk) questions[key] = args.question(key);
    const result = await decider.ask({ operation: args.operation, state: args.state(chunk), questions }, opts);
    if (!result) return;
    for (const { key, index } of chunk) out[index] = result.answers[key] as AnswerFor<Q>;
  });
  return out;
}

/** `fn` over `items`, at most `concurrency` at once, results in input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}
