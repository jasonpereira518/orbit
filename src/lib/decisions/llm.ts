import { completeJson, parseAiJson } from "@/lib/ai";
import type { AiAccess } from "@/lib/ai-access";
import type { AiOperationId, DecisionOperationId } from "@/lib/ai-operations";
import { withAiResultCache } from "@/lib/ai-result-cache";
import { chooseCompletionKey } from "@/lib/managed-ai-policy";
import {
  parseAnswers,
  type AskOptions,
  type Decider,
  type DecisionRequest,
  type DecisionResult,
  type Question,
  type QuestionMap,
} from "@/lib/decisions/jev";

/**
 * The same typed questions, answered by the person's own chat model — the engine a decision
 * falls back to when there is no TypeSafe key and the decision is rare or costly enough to
 * be worth a model call (see each policy in `catalog.ts`).
 *
 * Same `Decider` contract as Jev, same all-or-nothing validation (`parseAnswers`), so a call
 * site cannot tell the engines apart except by `engine`. Two differences it must respect:
 *
 *  - It is NOT calibrated. A model's "0.93" is a number it wrote, not a measured rate, so an
 *    LLM answer may veto, rank or suggest — never act on its own (`canAct` in engine.ts).
 *  - It is ~5× slower and ~10× dearer than Jev (docs/ai-evals/README.md). Hence the fast
 *    tier, temperature 0, and an output cap sized to the answer keys and nothing more.
 */

/**
 * Which fast-tier operation answers a decision. A decision absent here has no LLM engine.
 * Separate ids from the Jev ones because `ai_result_cache` keys on the operation, not the
 * model — a shared id would replay one engine's answer as the other's.
 */
export const LLM_OPERATION_FOR: Partial<Record<DecisionOperationId, AiOperationId>> = {
  "duplicates.same_person": "duplicates.same_person.llm",
  "mentions.resolve": "mentions.resolve.llm",
};

const SYSTEM = `You answer typed questions about a JSON "state" from a personal networking CRM.
Judge only from the state. Never assume facts it does not contain.
Answer every question, by its key:
- "yesno": the probability, from 0 to 1, that the answer is yes.
- "pick": exactly one of the option keys listed for it.
- "scale": the index of the level that fits best (0 is the first level).
Return JSON: {"<question key>": <answer>, ...}`;

function render(question: Question) {
  if (question.type === "noul") {
    return { kind: "yesno", ask: question.instructions, ...(question.criteria ? { yes_means: question.criteria.true, no_means: question.criteria.false } : {}) };
  }
  if (question.type === "choice") return { kind: "pick", ask: question.instructions, options: question.criteria };
  return { kind: "scale", ask: question.instructions, levels: question.criteria };
}

/** The model's compact reply, reshaped into TypeSafe's answer shape for `parseAnswers`. */
export function llmReplyToAnswers(questions: QuestionMap, reply: unknown): { answers: Record<string, unknown> } | null {
  if (!reply || typeof reply !== "object") return null;
  const raw = reply as Record<string, unknown>;
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    const v = raw[key];
    if (question.type === "noul") {
      const p = typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : NaN;
      answers[key] = { type: "noul", noul: Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : undefined };
    } else if (question.type === "choice") {
      answers[key] = { type: "choice", choice: typeof v === "string" ? v : undefined };
    } else {
      answers[key] = { type: "score", score: typeof v === "number" ? Math.round(v) : undefined };
    }
  }
  return { answers };
}

class LlmDecider implements Decider {
  constructor(
    private readonly userId: string,
    private readonly provider: string,
  ) {}

  async ask<Q extends QuestionMap>(request: DecisionRequest<Q>, opts: AskOptions): Promise<DecisionResult<Q> | null> {
    const operation = LLM_OPERATION_FOR[request.operation];
    if (!operation) return null;
    const keys = Object.keys(request.questions);
    const run = async (): Promise<DecisionResult<Q> | null> => {
      try {
        const signal = opts.signal
          ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), opts.signal])
          : AbortSignal.timeout(opts.timeoutMs);
        const content = await completeJson(this.userId, {
          operation,
          system: SYSTEM,
          user: JSON.stringify({
            state: request.state,
            questions: Object.fromEntries(keys.map((k) => [k, render(request.questions[k])])),
          }),
          temperature: 0,
          // The answer is a flat object of short values: a few tokens a key, never prose.
          maxOutputTokens: 24 + 12 * keys.length,
          signal,
        });
        const answers = parseAnswers(request.questions, llmReplyToAnswers(request.questions, parseAiJson(content)));
        return answers ? { answers, model: `llm:${this.provider}` } : null;
      } catch {
        // No key, a timeout, a refusal, a malformed reply: no answer. `completeJson` has
        // already recorded the failure in `usage_events`.
        return null;
      }
    };
    if (!opts.cacheDays) return run();
    try {
      return await withAiResultCache(
        this.userId,
        operation,
        { engine: "llm", provider: this.provider, state: request.state, questions: request.questions },
        run,
        { ttlDays: opts.cacheDays, accept: (v) => v !== null },
      );
    } catch {
      return null;
    }
  }
}

/**
 * The account's chat model as a decider, or null when it cannot run AI at all (no key of
 * any kind). Pure check on the account already resolved — no refusal is thrown, no call made.
 */
export function openLlmDecider(userId: string, access: AiAccess): Decider | null {
  const choice = chooseCompletionKey(access.facts());
  return choice.ok ? new LlmDecider(userId, choice.provider) : null;
}
