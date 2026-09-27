/**
 * The research loop that runs before a multi-step answer.
 *
 * The model is shown what retrieval already found and a set of read-only tools, and decides
 * what else it needs — "what did I discuss with her", "who at Stripe could intro me", "which
 * of my notes mention the Series A". It never writes the answer here. It gathers, and the
 * answer is written afterwards by the same streaming call as every other question, with what
 * was gathered added as a fenced evidence block.
 *
 * FOUR BOUNDS, all of which hold no matter what the model does:
 *
 *   - rounds: a model that keeps asking for "one more" lookup stops at `maxRounds`;
 *   - calls: a round asking for ten lookups gets as many as the budget has left, not ten;
 *   - time: each round's signal is the deadline, not the provider's own 45s, so a slow round
 *     eats into gathering and never into the time reserved for the answer;
 *   - failure: a provider error ends the loop and KEEPS what was gathered. The user still
 *     gets an answer — from less evidence, which beats an error card.
 *
 * Pure apart from what is injected: the driver (`@/lib/ai-tools`) and the executor (the
 * registry). `scripts/smoke-tool-loop.ts` drives it with fakes of both.
 */
import type { ToolCall, ToolDriver } from "@/lib/ai-tools";

export type ExecutedCall = {
  call: ToolCall;
  /** What the model was sent back, already capped. */
  content: string;
  /** The raw result for the caller — evidence rendering and the recommendation allowlist. */
  result: unknown;
  ok: boolean;
  /** True when this exact call was already made earlier in the loop and its result reused. */
  repeated: boolean;
};

export type ToolLoopOutcome = {
  calls: ExecutedCall[];
  rounds: number;
  stoppedBy: "done" | "rounds" | "calls" | "deadline" | "error" | "aborted";
  error?: unknown;
};

export type ToolExecutor = (call: ToolCall) => Promise<{ ok: boolean; result: unknown }>;

export type ToolLoopOptions = {
  maxRounds: number;
  maxCalls: number;
  /** Absolute epoch ms. Gathering never runs past it. */
  deadline: number;
  /** The request's own signal — the user left. */
  signal?: AbortSignal;
  /** Per result sent back to the model, so one lookup cannot flood the conversation. */
  maxResultChars: number;
  onCall?: (call: ToolCall) => void;
  now?: () => number;
};

function capped(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n… truncated` : text;
}

/** The identity of a call for dedupe: same tool, same arguments. */
function callKey(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.args ?? {})}`;
}

export async function runToolLoop(
  driver: ToolDriver,
  execute: ToolExecutor,
  options: ToolLoopOptions
): Promise<ToolLoopOutcome> {
  const now = options.now ?? Date.now;
  const calls: ExecutedCall[] = [];
  const seen = new Map<string, ExecutedCall>();
  let rounds = 0;

  while (true) {
    if (options.signal?.aborted) return { calls, rounds, stoppedBy: "aborted" };
    if (rounds >= options.maxRounds) return { calls, rounds, stoppedBy: "rounds" };
    if (calls.length >= options.maxCalls) return { calls, rounds, stoppedBy: "calls" };
    const remaining = options.deadline - now();
    if (remaining <= 0) return { calls, rounds, stoppedBy: "deadline" };

    // The round's own deadline, not the provider's default: a slow round must not borrow
    // from the time the answer needs. Combined with the caller's signal so a closed tab
    // stops the spend immediately.
    const roundSignal = options.signal
      ? AbortSignal.any([AbortSignal.timeout(remaining), options.signal])
      : AbortSignal.timeout(remaining);

    let step;
    try {
      step = await driver.step(roundSignal);
    } catch (error) {
      if (options.signal?.aborted) return { calls, rounds, stoppedBy: "aborted" };
      return {
        calls,
        rounds,
        stoppedBy: now() >= options.deadline ? "deadline" : "error",
        error,
      };
    }
    rounds++;

    if (step.calls.length === 0) return { calls, rounds, stoppedBy: "done" };

    // As many as the budget has left. Calls beyond it are still answered — the provider
    // requires a result for every call it made — just with a note instead of a lookup.
    const budget = options.maxCalls - calls.length;
    const toRun = step.calls.slice(0, budget);
    const skipped = step.calls.slice(budget);

    const results = await Promise.all(
      toRun.map(async (call): Promise<ExecutedCall> => {
        const key = callKey(call);
        const prior = seen.get(key);
        if (prior) {
          // A repeat is answered without re-running, and said so, so the model stops asking.
          return {
            call,
            content: "Same lookup as earlier in this conversation; see that result.",
            result: prior.result,
            ok: prior.ok,
            repeated: true,
          };
        }
        options.onCall?.(call);
        try {
          const { ok, result } = await execute(call);
          const executed: ExecutedCall = {
            call,
            content: capped(result, options.maxResultChars),
            result,
            ok,
            repeated: false,
          };
          seen.set(key, executed);
          return executed;
        } catch (err) {
          // A tool that throws is reported to the model as an error it can route around,
          // never as a reason to end the loop.
          const message = err instanceof Error ? err.message : "The lookup failed.";
          return {
            call,
            content: JSON.stringify({ error: message }),
            result: { error: message },
            ok: false,
            repeated: false,
          };
        }
      })
    );
    calls.push(...results.filter((r) => !r.repeated));

    driver.addResults([
      ...results.map((r) => ({ call: r.call, content: r.content })),
      ...skipped.map((call) => ({
        call,
        content: JSON.stringify({ error: "Lookup budget for this question is used up. Answer with what you have." }),
      })),
    ]);
  }
}
