import { resolveAiAccess, type AiAccess } from "@/lib/ai-access";
import {
  askPerItem,
  openDecider,
  type AnswerFor,
  type Answers,
  type Decider,
  type DecisionRequest,
  type Question,
  type QuestionMap,
} from "@/lib/decisions/jev";
import { openLlmDecider } from "@/lib/decisions/llm";
import type { DecisionOperationId } from "@/lib/ai-operations";
import type { SystemOneRequest } from "@/lib/typesafe-api";

/**
 * THE DECISION CHAIN — how every decision in Orbit is answered.
 *
 *   1. Jev (TypeSafe's decision model), when the account has a TypeSafe key: ~200ms,
 *      calibrated, the only engine allowed to act on its own.
 *   2. The account's own chat model, when the decision's policy allows it — decisions rare
 *      or costly enough to be worth a model call (the duplicate review band, an ambiguous
 *      mention). Frequent or latency-critical decisions never take this step.
 *   3. The rule the call site always had. Always last, always available, never a call.
 *
 * Without a TypeSafe key the chain simply starts at step 2 or 3 — the systems Orbit already
 * had are the main system, and Jev is an accelerator on top of them.
 *
 * One deadline covers the whole chain (`budgetMs`), so a slow Jev never stacks a full LLM
 * timeout behind it. `decide` never throws; `engine: "rules"` means "use your rule".
 */

export type Engine = "jev" | "llm" | "rules";

/** The engines one flow may use — opened once per scan, chat turn or capture. */
export type Engines = { jev: Decider | null; llm: Decider | null };

export const NO_ENGINES: Engines = Object.freeze({ jev: null, llm: null });

/**
 * One account read, then both engines. `llm: false` skips building the LLM engine for flows
 * whose policies never use it. `access`: the account already resolved for this request,
 * which skips even that read. Never throws: a failed read is "no engines", and every call
 * site then runs its rule.
 */
export async function openEngines(
  userId: string,
  opts: { llm?: boolean; access?: AiAccess } = {},
): Promise<Engines> {
  try {
    const access = opts.access?.forUser(userId) ?? (await resolveAiAccess(userId));
    const jev = await openDecider(userId, access);
    const llm = opts.llm ? openLlmDecider(userId, access) : null;
    return { jev, llm };
  } catch {
    return NO_ENGINES;
  }
}

export type DecisionPolicy = {
  /** Model engines, in order. The caller's rule is the implicit last step. */
  engines: ReadonlyArray<"jev" | "llm">;
  /** One deadline for the whole chain. */
  budgetMs: number;
  /** Jev's share of the budget, so the LLM keeps enough to answer when Jev fails. */
  jevMs?: number;
  /** Replay an identical question set's answer for this many days. */
  cacheDays?: number;
};

/** Below this, a model engine is not started: it could not answer in time anyway. */
const MIN_ENGINE_MS = 150;

export type Decided<Q extends QuestionMap> =
  | { engine: "jev" | "llm"; answers: Answers<Q>; model: string }
  | { engine: "rules"; answers: null; model: null };

const RULES = { engine: "rules", answers: null, model: null } as const;

export async function decide<Q extends QuestionMap>(
  engines: Engines,
  policy: DecisionPolicy,
  request: { operation: DecisionOperationId; state: SystemOneRequest["state"]; questions: Q },
  opts: { signal?: AbortSignal } = {},
): Promise<Decided<Q>> {
  const deadline = Date.now() + policy.budgetMs;
  for (const name of policy.engines) {
    const decider = engines[name];
    if (!decider) continue;
    const remaining = deadline - Date.now();
    if (remaining < MIN_ENGINE_MS) break;
    const timeoutMs = name === "jev" && policy.jevMs ? Math.min(policy.jevMs, remaining) : remaining;
    const result = await decider
      .ask(request as DecisionRequest<Q>, { timeoutMs, signal: opts.signal, cacheDays: policy.cacheDays })
      .catch(() => null);
    if (result) return { engine: name, answers: result.answers, model: result.model };
  }
  return RULES;
}

export type DecidedItem<Q extends Question> =
  | { engine: "jev" | "llm"; answer: AnswerFor<Q> }
  | { engine: "rules"; answer: null };

/**
 * `decide` for one question per item (`askPerItem`): Jev answers what it can, the LLM (if the
 * policy allows) answers only the items Jev left unanswered, and the rest are the caller's
 * rule. Same shared deadline.
 */
export async function decideEach<T, Q extends Question>(
  engines: Engines,
  policy: DecisionPolicy,
  args: Parameters<typeof askPerItem<T, Q>>[1],
): Promise<Array<DecidedItem<Q>>> {
  const out: Array<DecidedItem<Q>> = args.items.map(() => ({ engine: "rules", answer: null }));
  const deadline = Date.now() + policy.budgetMs;
  let pending = args.items.map((_, i) => i);
  for (const name of policy.engines) {
    const decider = engines[name];
    if (!decider || pending.length === 0) continue;
    const remaining = deadline - Date.now();
    if (remaining < MIN_ENGINE_MS) break;
    const timeoutMs = name === "jev" && policy.jevMs ? Math.min(policy.jevMs, remaining) : remaining;
    const answers = await askPerItem(
      decider,
      { ...args, items: pending.map((i) => args.items[i]) },
      { timeoutMs, cacheDays: policy.cacheDays },
    ).catch(() => pending.map(() => null));
    const still: number[] = [];
    answers.forEach((answer, j) => {
      const index = pending[j];
      if (answer) out[index] = { engine: name, answer };
      else still.push(index);
    });
    pending = still;
  }
  return out;
}

/**
 * Whether an answer may ACT on its own — auto-merge, skip a calendar contact, link a mention.
 * Only Jev (its probabilities are measured by the eval's calibration bins; an LLM's are not),
 * only when the decision's `act` threshold is set (every one ships `null` until its bins show
 * precision 1.0 on n ≥ 20), and only at or above it.
 */
export function canAct(engine: Engine, probability: number | null | undefined, actAbove: number | null): boolean {
  return engine === "jev" && actAbove !== null && typeof probability === "number" && probability >= actAbove;
}
