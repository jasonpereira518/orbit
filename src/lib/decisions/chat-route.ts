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
  /** Load the user's upcoming meetings into the answer (chat-context's calendar block). */
  calendar: boolean;
  /** …with the free gaps between them. */
  availability: boolean;
  /** Preparing for one meeting: its people are the subject, not whoever the search ranks. */
  prep: boolean;
  engine: "llm" | "default";
};

export type PriorTurn = { role: string; content: string };

const ONE_PASS: DepthDecision = { depth: "single", reason: "one retrieval answers it" };

/**
 * The free fallback for when the parser does not answer: a calendar question still gets the
 * calendar block. The parser's `intent.calendar` covers phrasings this misses.
 */
const CALENDAR_QUESTION =
  /\b(my (calendar|schedule|agenda|next meeting|meetings?|calls?)|meeting (with|today|tomorrow)|on my plate|what'?s on (today|tomorrow|this week)|(today|tomorrow)'?s (meetings?|calls?|schedule)|prep(are)? me|next (see|meet|meeting)|am i (meeting|seeing|free|busy|available)|my \d{1,2}(:\d{2})? ?(am|pm)?\b|(free|open) (slot|time)|when am i free)/i;
const AVAILABILITY_QUESTION = /\b(am i (free|busy|available)|free (slot|time)|open (slot|time)|when am i free|availability)\b/i;
/**
 * Preparing for one meeting wants `meeting_context` — each attendee's history and what is open —
 * which the answer looks up itself. A schedule question is answered from the calendar block.
 */
const PREP_QUESTION = /\b(prep(are)? me|brief me|get me ready)\b/i;
const PREP: DepthDecision = { depth: "research", reason: "prepares for a meeting" };

export function routeFromParsed(parsed: ParsedQuery | null, question: string): ChatRoute {
  const intent = parsed?.intent;
  const keywordCalendar = CALENDAR_QUESTION.test(question);
  const prep = PREP_QUESTION.test(question);
  if (!parsed || !intent) {
    return {
      depth: prep ? PREP : ONE_PASS,
      shape: parsed?.shape ?? "open",
      attention: isAttentionQuestion(question),
      recruiters: isRecruiterIntent(question),
      calendar: keywordCalendar,
      availability: AVAILABILITY_QUESTION.test(question),
      prep,
      engine: "default",
    };
  }
  // A bare name or a two-word query stays a lookup whatever the parser says: a research
  // round on "Ada Park" is pure waste.
  const short = question.trim().split(/\s+/).length <= 2;
  const availability = intent.availability === true || AVAILABILITY_QUESTION.test(question);
  return {
    depth: prep
      ? PREP
      : intent.needsResearch && !short
        ? { depth: "research", reason: "needs more than one lookup" }
        : ONE_PASS,
    shape: parsed.shape,
    attention: intent.attention,
    recruiters: intent.recruiters,
    // The parser answered, so its word stands: the keyword list is only the fallback ("notes
    // from my calls" is about notes, not the schedule — eval said-11).
    calendar: intent.calendar === true || availability,
    availability,
    prep,
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
