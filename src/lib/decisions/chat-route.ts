import { isAttentionQuestion } from "@/lib/chat-attention-match";
import { isRecruiterIntent } from "@/lib/recruiters";
import type { OrgRoster } from "@/lib/chat-roster";
import type { ParsedQuery, QuestionShape } from "@/lib/chat-retrieval";
import { CHAT_ROUTE_TUNING, rosterQuestion } from "@/lib/decisions/catalog";
import { decide, type Engine } from "@/lib/decisions/engine";
import type { Decider } from "@/lib/decisions/jev";

export type ChatDepth = "single" | "research";

export type DepthDecision = {
  depth: ChatDepth;
  /** Why, for the step label and for debugging a surprising choice. */
  reason: string;
};

/**
 * How a chat question is routed: its shape (which retrieval lanes run), one pass or a
 * research round, whether the attention brief (with its "answer from this" rule) loads, and
 * whether the recruiter list does.
 *
 * Decided by the question parser (`understandQuery`) in the call retrieval already makes, so
 * routing costs no extra round trip. When that call fails the question gets the safe
 * default: one pass, shape "open", and only the two keyword checks that cost nothing.
 */
export type ChatRoute = {
  depth: DepthDecision;
  shape: QuestionShape;
  attention: boolean;
  recruiters: boolean;
  engine: "llm" | "default";
};

export type PriorTurn = { role: string; content: string };

const ONE_PASS: DepthDecision = { depth: "single", reason: "one retrieval answers it" };

export function routeFromParsed(parsed: ParsedQuery | null, question: string): ChatRoute {
  const intent = parsed?.intent;
  if (!parsed || !intent) {
    return {
      depth: ONE_PASS,
      shape: parsed?.shape ?? "open",
      attention: isAttentionQuestion(question),
      recruiters: isRecruiterIntent(question),
      engine: "default",
    };
  }
  // A bare name or a two-word query stays a lookup whatever the parser says: a research
  // round on "Ada Park" is pure waste.
  const short = question.trim().split(/\s+/).length <= 2;
  return {
    depth: intent.needsResearch && !short ? { depth: "research", reason: "needs more than one lookup" } : ONE_PASS,
    shape: parsed.shape,
    attention: intent.attention,
    recruiters: intent.recruiters,
    engine: "llm",
  };
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
