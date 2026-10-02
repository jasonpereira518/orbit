/**
 * The waitlist page's feature poll, minus the database: the options, the floor, and the two
 * pure functions the page needs — turn a tally into a ranking, and predict a vote's effect
 * before the server confirms it.
 *
 * CLIENT-SAFE ON PURPOSE. `components/interest/feature-poll.tsx` imports this; anything here
 * that reached `@/db` would fail the client build with a `node:fs` chunk error. The
 * database half is `waitlist-poll-votes.ts`.
 *
 * STARS. Everyone spends a budget of stars — `BASE_STARS`, plus one per friend who joined
 * through their link (`starBudget`) — across the options, stacked or spread. The tally is star
 * totals, and `voters` counts the people behind them.
 *
 * THE FLOOR. Below `POLL_RESULTS_FLOOR` voters the ranking carries no numbers: three voters
 * read as "100% / 0% / 0%", which is noise dressed as a result. It is the same idea as the
 * proof line's count floor.
 *
 * COPY. The waitlist is unbranded — no option label may name the product.
 */

export const POLL_OPTIONS = [
  {
    id: "constellation-map",
    label: "Constellation Map",
    blurb: "your whole network, mapped as a living galaxy",
  },
  {
    id: "network-chat",
    label: "Network Chat",
    blurb: "ask your network anything, get answers instantly",
  },
  {
    id: "outreach-campaign",
    label: "Outreach Campaign",
    blurb: "finds the right people, drafts the message for you",
  },
  {
    id: "events",
    label: "Events",
    blurb: "see who's converging at every event before you arrive",
  },
  {
    id: "auto-integrations",
    label: "Auto-Integrations",
    blurb: "your inbox and calendar sync themselves in",
  },
  {
    id: "smart-follow-ups",
    label: "Smart Follow-Ups",
    blurb: "the right nudge, exactly when it matters",
  },
] as const;

export type PollOptionId = (typeof POLL_OPTIONS)[number]["id"];

/** Voters below which the ranking shows order only. */
export const POLL_RESULTS_FLOOR = 25;

/** Stars everyone starts with, to spread across the options or stack on one. */
export const BASE_STARS = 3;
/** Each friend who joins through your link adds a star, up to this many. */
export const MAX_FRIEND_STARS = 10;

/** How many stars someone with `referrals` friends on the waitlist may spend. */
export function starBudget(referrals: number): number {
  return BASE_STARS + Math.min(Math.max(0, Math.floor(referrals) || 0), MAX_FRIEND_STARS);
}

/** The httpOnly cookie that identifies an anonymous voter. */
export const POLL_VOTER_COOKIE = "wp_voter";

export const POLL_ERROR = "Couldn't save your vote — please try again.";
export const POLL_OVER_BUDGET = "That's more stars than you have — take one back first.";
export const POLL_RATE_LIMITED = "That's a lot of votes — give it a minute and try again.";
export const POLL_RESULTS_CAPTION = "Spend your stars on what you want first.";

/**
 * Stars per option id, and how many people have voted. Ids not in `POLL_OPTIONS` may appear
 * (a retired option) and are ignored.
 */
export type PollResults = { counts: Record<string, number>; voters: number };

/** One person's stars: option id → how many they put on it. Zeros are absent. */
export type StarAllocation = Partial<Record<PollOptionId, number>>;

export type RankedOption = {
  id: PollOptionId;
  label: string;
  blurb: string;
  /** Stars on this option, from everyone. */
  count: number;
  /** 1-based position after ranking. */
  rank: number;
  /** Whole-number percent of the total, or null below the floor. */
  share: number | null;
  /** 0–1, relative to the leading option, for the bar. */
  bar: number;
};

const OPTION_IDS: ReadonlySet<string> = new Set(POLL_OPTIONS.map((o) => o.id));

export function isPollOptionId(value: unknown): value is PollOptionId {
  return typeof value === "string" && OPTION_IDS.has(value);
}

/** What a voter cookie looks like — a UUID, but any 16–64 url-safe characters pass. */
const VOTER_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function isVoterId(value: unknown): value is string {
  return typeof value === "string" && VOTER_ID.test(value);
}

/**
 * Whatever a client (or a stored row) sent, reduced to what can be counted: known option ids
 * with whole, positive star counts. The server re-runs this on every write.
 */
export function normalizeAllocation(raw: unknown): StarAllocation {
  const out: StarAllocation = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, n] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPollOptionId(id) || typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
    out[id] = Math.min(n, 1000);
  }
  return out;
}

export function allocationTotal(a: StarAllocation): number {
  let total = 0;
  for (const n of Object.values(a)) total += n ?? 0;
  return total;
}

/** The option with the most stars; ties go to the one authored first. Null with no stars. */
export function topPick(a: StarAllocation): PollOptionId | null {
  let best: PollOptionId | null = null;
  let bestN = 0;
  for (const o of POLL_OPTIONS) {
    const n = a[o.id] ?? 0;
    if (n > bestN) {
      best = o.id;
      bestN = n;
    }
  }
  return best;
}

/** A vote cast before stars existed counted once; it now reads as the whole base budget. */
export function legacyAllocation(optionId: string): StarAllocation {
  return isPollOptionId(optionId) ? { [optionId]: BASE_STARS } : {};
}

/**
 * Ranks the listed options by stars; ties keep authored order. The total counts only listed
 * options, so a retired option's stars cannot skew the percentages. Numbers appear once
 * `voters` reaches the floor.
 */
export function rankPoll(results: PollResults): {
  options: RankedOption[];
  total: number;
  showNumbers: boolean;
} {
  const rows = POLL_OPTIONS.map((option, index) => ({
    option,
    index,
    count: Math.max(0, Math.floor(results.counts[option.id] ?? 0)),
  }));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const showNumbers = results.voters >= POLL_RESULTS_FLOOR && total > 0;
  const options = [...rows]
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ option, count }, i) => ({
      id: option.id,
      label: option.label,
      blurb: option.blurb,
      count,
      rank: i + 1,
      share: showNumbers ? Math.round((count / total) * 100) : null,
      bar: max > 0 ? count / max : 0,
    }));
  return { options, total, showNumbers };
}

/**
 * The tally as it will read once the server confirms a change of stars: `before` comes off,
 * `after` goes on, and a person's first stars add a voter (their last removal takes one away).
 * Used for the optimistic update; the server's answer replaces it.
 */
export function applyAllocation(
  results: PollResults,
  before: StarAllocation,
  after: StarAllocation
): PollResults {
  const counts = { ...results.counts };
  for (const o of POLL_OPTIONS) {
    const delta = (after[o.id] ?? 0) - (before[o.id] ?? 0);
    if (delta !== 0) counts[o.id] = Math.max(0, (counts[o.id] ?? 0) + delta);
  }
  const had = allocationTotal(before) > 0;
  const has = allocationTotal(after) > 0;
  const voters = Math.max(0, results.voters + (has && !had ? 1 : !has && had ? -1 : 0));
  return { counts, voters };
}
