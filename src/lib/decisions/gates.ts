import { SKIP_GATES, SKIP_GATE_TUNING } from "@/lib/decisions/catalog";
import { decide, type Engines } from "@/lib/decisions/engine";
import type { DecisionOperationId } from "@/lib/ai-operations";

/**
 * Skip-gates: a ~200ms Jev yes/no in front of a chat-model call that usually finds nothing
 * (see `SKIP_GATES` in catalog.ts). True means "skip the call" — only on a confident Jev
 * "no". Every other outcome — no TypeSafe key, a timeout, an unsure answer — runs the call,
 * so without Jev each step behaves exactly as it always has.
 *
 * Only Jev answers a gate. A chat model asked "is there anything here?" costs about as much
 * as the call it would save, so there is nothing to fall back to and nothing is lost.
 */
export type GateName = keyof typeof SKIP_GATES;

const OPERATION: Record<GateName, DecisionOperationId> = {
  dates: "capture.dates.gate",
  brief: "contact.brief.gate",
  starters: "extension.starters.gate",
  enrich: "import.enrich.gate",
  timeline: "import.linkedin.timeline.decide",
};

/**
 * The probability that there IS something here, or null when nobody answered. Exported for
 * the eval, which needs the number itself to calibrate each gate's threshold.
 */
export async function gateProbability(
  engines: Engines,
  gate: GateName,
  state: Record<string, unknown>,
): Promise<number | null> {
  if (!engines.jev) return null;
  const decided = await decide(
    { jev: engines.jev, llm: null },
    { engines: ["jev"], budgetMs: SKIP_GATE_TUNING.budgetMs },
    { operation: OPERATION[gate], state, questions: { yes: SKIP_GATES[gate] } },
  ).catch(() => null);
  return decided?.engine === "jev" ? decided.answers.yes.probability : null;
}

export async function gateSkips(
  engines: Engines,
  gate: GateName,
  state: Record<string, unknown>,
): Promise<boolean> {
  // A gate turned off in the catalog is not asked at all: asking and then ignoring the
  // answer would bill for a decision nobody acts on. The eval calls `gateProbability`
  // directly, so an off gate is still measured on every run.
  const at = SKIP_GATE_TUNING.skipAtOrBelow[gate];
  if (at === null) return false;
  const p = await gateProbability(engines, gate, state);
  return p !== null && p <= at;
}

/** A long input, trimmed to what the gate reads. */
export function gateText(text: string): string {
  return text.slice(0, SKIP_GATE_TUNING.inputChars);
}
