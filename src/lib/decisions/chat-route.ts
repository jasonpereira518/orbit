import { chooseDepth, type DepthDecision } from "@/lib/chat-depth";
import { isAttentionQuestion } from "@/lib/chat-attention-match";
import { isRecruiterIntent } from "@/lib/recruiters";
import type { OrgRoster } from "@/lib/chat-roster";
import {
  CHAT_ROUTE_TUNING,
  DEPTH_REASONS,
  chatRouteQuestions,
  rosterQuestion,
  type DepthReason,
} from "@/lib/decisions/catalog";
import { decide, type Engine } from "@/lib/decisions/engine";
import type { Decider } from "@/lib/decisions/jev";

/**
 * How a chat question is routed: one lookup or a research round, whether the attention brief
 * (with its "answer from this" rule) loads, and whether the recruiter list does.
 *
 * The chain, per the decisions plan:
 *  1. Jev — one call, all three questions, beside retrieval (no added latency).
 *  2. The question parser's own `intent` flags (`understandQuery`) — the call already runs on
 *     every question, so the person's chat model routes it at no extra cost.
 *  3. The keyword rules that route today (`chooseDepth`, `isAttentionQuestion`,
 *     `isRecruiterIntent`).
 */
export type ChatRoute = {
  depth: DepthDecision;
  attention: boolean;
  recruiters: boolean;
  engine: Engine;
};

/** What the question parser says about routing, when it answered. */
export type ParsedIntent = { needsResearch: boolean; attention: boolean; recruiters: boolean };

export type PriorTurn = { role: string; content: string };

export function rulesRoute(question: string, hasPriorTurns: boolean): ChatRoute {
  return {
    depth: chooseDepth(question, { hasPriorTurns }),
    attention: isAttentionQuestion(question),
    recruiters: isRecruiterIntent(question),
    engine: "rules",
  };
}

/** The parser's flags as a route. Booleans only: an LLM's routing has no probability to trust. */
export function routeFromIntent(intent: ParsedIntent, question: string, hasPriorTurns: boolean): ChatRoute {
  const rules = chooseDepth(question, { hasPriorTurns });
  // A bare name or a two-word query stays a lookup whatever the parser says — the same floor
  // the rules have, because a research round on "Ada Park" is pure waste.
  const short = rules.reason === "short lookup";
  return {
    depth: intent.needsResearch && !short
      ? { depth: "research", reason: "needs more than one lookup" }
      : short
        ? rules
        : { depth: "single", reason: "one retrieval answers it" },
    attention: intent.attention,
    recruiters: intent.recruiters,
    engine: "llm",
  };
}

function priorTurnState(turns: readonly PriorTurn[]) {
  return turns
    .slice(-CHAT_ROUTE_TUNING.priorTurns)
    .map((t) => ({ role: t.role, text: t.content.replace(/\s+/g, " ").slice(0, CHAT_ROUTE_TUNING.priorTurnChars) }));
}

export async function routeChatQuestion(input: {
  decider: Decider | null;
  question: string;
  /** Oldest first, as `ChatContext.priorTurns`. */
  priorTurns: readonly PriorTurn[];
  /** Resolves to the parser's flags, or null when it did not answer. Awaited only without Jev. */
  intent: () => Promise<ParsedIntent | null>;
}): Promise<ChatRoute> {
  const hasPriorTurns = input.priorTurns.length > 0;
  const rules = rulesRoute(input.question, hasPriorTurns);
  // The rules' short-lookup floor is not a judgement anything could improve on.
  if (rules.depth.reason === "short lookup" && !rules.attention && !rules.recruiters) return rules;

  if (input.decider) {
    const decided = await decide(
      { jev: input.decider, llm: null },
      { engines: ["jev"], budgetMs: CHAT_ROUTE_TUNING.timeoutMs },
      {
        operation: "chat.route",
        state: { question: input.question, prior_turns: priorTurnState(input.priorTurns) },
        questions: chatRouteQuestions,
      },
    );
    if (decided.engine === "jev") {
      const { attention, recruiters } = decided.answers;
      // The strongest research reason, if any clears the bar. A follow-up with no earlier
      // turns has nothing to follow up on, so that one only counts with prior turns.
      const reasons = (Object.keys(DEPTH_REASONS) as DepthReason[])
        .filter((r) => r !== "followUp" || hasPriorTurns)
        .map((r) => ({ r, p: decided.answers[r].probability }))
        .sort((a, b) => b.p - a.p);
      const top = reasons[0];
      const research = Boolean(top && top.p >= CHAT_ROUTE_TUNING.researchAbove);
      return {
        depth: research
          ? { depth: "research", reason: DEPTH_REASONS[top.r] }
          : rules.depth.reason === "short lookup"
            ? rules.depth
            : { depth: "single", reason: "one retrieval answers it" },
        attention: attention.probability >= CHAT_ROUTE_TUNING.attentionAbove,
        recruiters: recruiters.probability >= CHAT_ROUTE_TUNING.recruitersAbove,
        engine: "jev",
      };
    }
  }

  const intent = await input.intent().catch(() => null);
  if (intent) return routeFromIntent(intent, input.question, hasPriorTurns);
  return rules;
}

/**
 * Which matched organisations the question is actually ABOUT. `findOrgRosters` matches any
 * org name that appears as a whole word, so "ramp up", "a notion of" and "before Stripe"
 * attached exhaustive rosters with an "authoritative" prompt rule. Jev only; without it the
 * rosters stand exactly as matched.
 */
export async function gateRosters(
  decider: Decider | null,
  question: string,
  rosters: OrgRoster[],
): Promise<{ rosters: OrgRoster[]; engine: Engine }> {
  if (!decider || rosters.length === 0) return { rosters, engine: "rules" };
  const keys = rosters.map((_, i) => `o${String(i + 1).padStart(2, "0")}`);
  const decided = await decide(
    { jev: decider, llm: null },
    { engines: ["jev"], budgetMs: CHAT_ROUTE_TUNING.timeoutMs },
    {
      operation: "chat.roster",
      state: { question, orgs: Object.fromEntries(rosters.map((r, i) => [keys[i], `${r.name} (${r.kind})`])) },
      questions: Object.fromEntries(keys.map((k) => [k, rosterQuestion(k)])),
    },
  );
  if (decided.engine !== "jev") return { rosters, engine: "rules" };
  return {
    rosters: rosters.filter((_, i) => decided.answers[keys[i]].probability >= CHAT_ROUTE_TUNING.rosterAbove),
    engine: "jev",
  };
}
