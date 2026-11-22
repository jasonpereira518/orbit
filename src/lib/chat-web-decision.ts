/**
 * Whether one chat question may search the public web — pure, so the route, the composer and
 * the smoke share one rule.
 *
 * "Web search" in chat is the three lookup tools (`research_person`, `research_company`,
 * `find_people`): the answer model is only OFFERED them when this says so. Each call is still
 * gated where it runs (`webSearchJson`: the admin pause, the account's monthly cap, Orbit's
 * daily ceiling, the plan), so nothing here can widen what a search is allowed to cost; it
 * only decides whether the tools are on the table.
 *
 * THE CHOICE is a tri-state the person holds per chat:
 *   - "auto" (the default): the question decides, by `classifyWebNeed`;
 *   - "on": the person asked for the web on every question in this chat;
 *   - "off": the person said never — an explicit off beats auto, always.
 * On the wire it is the request's `web` field; absent means auto, and the booleans the old
 * switch sent still mean what they did (`false` = off, `true` = on).
 *
 * THE CLASSIFIER is deliberately cheap and deterministic: no extra model call per message.
 * It looks for what only the public web could answer (a link, an explicit "search the web",
 * news and live figures, "who is the CEO of …", research on someone outside the records) and
 * is vetoed by the signs that the question is about the person's OWN records ("my contacts",
 * "who do I know", "remind me", drafting a message). Anything ambiguous is NOT a search: the
 * cost of a miss is one tap on the globe, the cost of a false positive is a paid search.
 */

export type WebChoice = "auto" | "on" | "off";

/** What the request said. Anything unrecognised is auto. */
export function parseWebChoice(raw: unknown): WebChoice {
  if (raw === "on" || raw === true) return "on";
  if (raw === "off" || raw === false) return "off";
  return "auto";
}

export type WebReason = "explicit" | "link" | "news" | "market" | "outside";

/** Said after "Web search turned on —" in the step trail. */
export const WEB_REASON_TEXT: Record<WebReason, string> = {
  explicit: "you asked for a web search",
  link: "your message has a link",
  news: "it asks about recent news",
  market: "it asks for live figures",
  outside: "it asks about someone or something outside your records",
};

/* ------------------------------------------------------------------ classifier ---- */

/** Signs the question is about the person's own records. They veto every weak web signal. */
const RECORDS_ONLY = [
  /\b(my|our)\s+(contacts?|network|notes?|reminders?|calendar|meetings?|inbox|e-?mails?|records|crm|people|follow[- ]?ups?|connections?|tags?|goals?|events?|timeline|interactions?|messages?)\b/,
  /\bwho\s+(do|did|have|should)\s+(i|we)\b/,
  /\b(did|have|do|was|am)\s+(i|we)\b/,
  /\bi\s+(know|met|talked|spoke|emailed|called|saw|last|haven'?t|owe)\b/,
  /\b(remind|reminders?|follow[- ]?ups?|overdue|reach(ing)? out|catch up|reconnect)\b/,
  // Writing to someone is about them and the user, not the web.
  /\b(draft|write|compose|rewrite|reply|respond|polish|shorten|rephrase)\b/,
  /\b(intro(duce|duction)?|warm path)\b/,
  /\b(the )?(last|latest|most recent) (time|note|conversation|meeting|call|email)\b/,
];

/** An explicit ask for the web. Never vetoed: the person said so. */
const EXPLICIT = [
  /\b(search|browse|look(ing)?\s+(it\s+|him\s+|her\s+|them\s+|this\s+|that\s+)?up)\b[^.?!\n]{0,24}\b(the\s+)?(web|internet|online|google)\b/,
  /\b(on|from|via|using)\s+the\s+(web|internet)\b/,
  /\bweb\s+(search|lookup|research)\b/,
  /\b(google|bing)\s+(it|him|her|them|this|that|for)\b/,
  /\bsearch\s+(online|google)\b/,
  /\bonline\s+(search|research)\b/,
];

/** A pasted link. The page is the subject. Not vetoed. */
const LINK = /\b(https?:\/\/|www\.)[^\s]+/;

/** Asking about someone beyond the records, in so many words. Not vetoed ("outside my network"). */
const OUTSIDE_NETWORK = [
  /\b(outside|beyond)\s+(of\s+)?(my|our)\s+(network|contacts|records|circle)\b/,
  /\b(people|someone|anyone|folks|founders?|investors?|recruiters?|engineers?|managers?|pms?)\b[^.?!\n]{0,40}\b(i|we)\s+(don'?t|do not|haven'?t|have not)\s+(yet\s+)?(know|met)\b/,
  /\bfind\s+(me\s+)?(some\s+)?new\s+(people|contacts|connections|leads)\b/,
];

/** News and live figures. Weak: a veto wins. */
const NEWS = [
  /\b(latest|breaking|recent|current|today'?s|this\s+(week|month|year)'?s)\b[^.?!\n]{0,30}\b(news|headlines?|developments?|announcements?|funding|earnings|results|releases?|launch(es)?)\b/,
  /\b(news|headlines)\s+(about|on|for|from)\b/,
  /\bin\s+the\s+news\b/,
  /\bwhat('?s| is)\s+(happening|going on)\s+(with|at|in)\b[^.?!\n]{0,40}\b(today|this week|right now|lately)\b/,
];
const MARKET = [
  /\b(stock|share)\s+price\b/,
  /\bmarket\s+cap(italization)?\b/,
  /\b(weather|forecast)\b/,
  /\bexchange\s+rate\b/,
  /\b(price|value)\s+of\s+(bitcoin|ethereum|btc|eth|gold|oil)\b/,
];

/** Someone or something no record of the user's could know. Weak: a veto wins. */
const OUTSIDE = [
  /\bwho\s+(is|are|was)\s+the\s+(current\s+|new\s+)?(ceo|cto|cfo|coo|cmo|founder|co-?founder|president|chair(man|woman)?|head\s+of\s+\w+|vp\s+of\s+\w+)\s+(of|at)\b/,
  /\b(research|background\s+(check\s+)?on|dig\s+into|do\s+(some\s+)?(research|digging)\s+on|dossier\s+on)\b/,
];

const any = (patterns: readonly RegExp[], q: string) => patterns.some((p) => p.test(q));

/**
 * Whether the question can only be answered from the public web. Ambiguity is a "no".
 * `reason` says which signal fired, for the step trail.
 */
export function classifyWebNeed(question: string): { needs: boolean; reason: WebReason | null } {
  const q = question.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!q) return { needs: false, reason: null };
  if (any(EXPLICIT, q)) return { needs: true, reason: "explicit" };
  if (LINK.test(q)) return { needs: true, reason: "link" };
  if (any(OUTSIDE_NETWORK, q)) return { needs: true, reason: "outside" };
  if (any(RECORDS_ONLY, q)) return { needs: false, reason: null };
  if (any(NEWS, q)) return { needs: true, reason: "news" };
  if (any(MARKET, q)) return { needs: true, reason: "market" };
  if (any(OUTSIDE, q)) return { needs: true, reason: "outside" };
  return { needs: false, reason: null };
}

/* -------------------------------------------------------------------- decision ---- */

/** Why the web cannot be searched right now, when it cannot. */
export type WebBlock = "paused" | "no_provider";
export type WebAvailability = { ok: true } | { ok: false; why: WebBlock };

export type WebTurn = {
  /** Whether the lookup tools are offered to this answer. */
  on: boolean;
  /** Who made the call: the person's switch, or the question. */
  source: "user" | "auto";
  /** Set when the web was wanted (by the person or the question) but cannot be searched. */
  blocked: WebBlock | null;
  /** The signal that turned auto on. */
  reason: WebReason | null;
};

/**
 * The one decision per message. The person's explicit off always wins; auto never turns the
 * tools on past an admin pause or a provider that cannot search — it falls back to the
 * records and says so (`webStep`).
 */
export function decideWebForTurn(input: {
  choice: WebChoice;
  question: string;
  availability: WebAvailability;
}): WebTurn {
  const { choice, availability } = input;
  if (choice === "off") return { on: false, source: "user", blocked: null, reason: null };
  const wanted =
    choice === "on"
      ? { needs: true, reason: null as WebReason | null }
      : classifyWebNeed(input.question);
  const source = choice === "on" ? "user" : "auto";
  if (!wanted.needs) return { on: false, source, blocked: null, reason: null };
  if (!availability.ok) return { on: false, source, blocked: availability.why, reason: wanted.reason };
  return { on: true, source, blocked: null, reason: wanted.reason };
}

const BLOCK_TEXT: Record<WebBlock, string> = {
  paused: "Web search is paused right now — answering from your records",
  no_provider: "Web search isn’t available on your AI setup — answering from your records",
};

/**
 * The one line the step trail shows, or null when there is nothing to say: a quiet auto-off
 * emits nothing (a stage that did not run leaves no step), and a person's own "on" needs no
 * announcement. Ids are fixed so the client can tell "turned itself on" from "unavailable".
 */
export function webStep(turn: WebTurn): { id: "web:auto" | "web:blocked"; label: string } | null {
  if (turn.blocked) return { id: "web:blocked", label: BLOCK_TEXT[turn.blocked] };
  if (turn.on && turn.source === "auto" && turn.reason) {
    return { id: "web:auto", label: `Web search turned on — ${WEB_REASON_TEXT[turn.reason]}` };
  }
  return null;
}
