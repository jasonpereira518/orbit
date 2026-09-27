/**
 * The waitlist page's feature poll, minus the database: the options, the floor, and the two
 * pure functions the page needs — turn a tally into a ranking, and predict a vote's effect
 * before the server confirms it.
 *
 * CLIENT-SAFE ON PURPOSE. `components/interest/feature-poll.tsx` imports this; anything here
 * that reached `@/db` would fail the client build with a `node:fs` chunk error. The
 * database half is `waitlist-poll-votes.ts`.
 *
 * THE FLOOR. Below `POLL_RESULTS_FLOOR` total votes the ranking carries no numbers: three
 * votes read as "100% / 0% / 0%", which is noise dressed as a result. It is the same idea as
 * the proof line's count floor.
 *
 * COPY. The waitlist is unbranded — no option label may name the product.
 */

export const POLL_OPTIONS = [
  { id: "ask-network", label: "Network Chat — ask your network anything" },
  { id: "reminders", label: "Smart Reminders — reach out at the right moment" },
  { id: "auto-import", label: "Auto-Import — pull in your inbox and calendar" },
  { id: "network-map", label: "Network Map — a visual view of everyone you know" },
  { id: "drafted-outreach", label: "Drafted Outreach — ready-to-send messages, written for you" },
  { id: "find-people", label: "People Discovery — find new people worth knowing" },
] as const;

export type PollOptionId = (typeof POLL_OPTIONS)[number]["id"];

/** Total votes below which the ranking shows order only. */
export const POLL_RESULTS_FLOOR = 25;

/** The httpOnly cookie that identifies an anonymous voter. */
export const POLL_VOTER_COOKIE = "wp_voter";

export const POLL_ERROR = "Couldn't save your vote — please try again.";
export const POLL_RATE_LIMITED = "That's a lot of votes — give it a minute and try again.";
export const POLL_RESULTS_CAPTION = "Vote for your favorite feature to come first.";

/** Votes per option id. Ids not in `POLL_OPTIONS` may appear (a retired option) and are ignored. */
export type PollResults = { counts: Record<string, number> };

export type RankedOption = {
  id: PollOptionId;
  label: string;
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
 * Ranks the listed options by votes; ties keep authored order. The total counts only listed
 * options, so a retired option's votes cannot skew the percentages.
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
  const showNumbers = total >= POLL_RESULTS_FLOOR;
  const options = [...rows]
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ option, count }, i) => ({
      id: option.id,
      label: option.label,
      count,
      rank: i + 1,
      share: showNumbers ? Math.round((count / total) * 100) : null,
      bar: max > 0 ? count / max : 0,
    }));
  return { options, total, showNumbers };
}

/**
 * The tally as it will read once the server confirms this vote: one off `previous`, one on
 * `next`. Used for the optimistic update; the server's answer replaces it.
 */
export function applyVote(
  results: PollResults,
  previous: PollOptionId | null,
  next: PollOptionId
): PollResults {
  const counts = { ...results.counts };
  if (previous) counts[previous] = Math.max(0, (counts[previous] ?? 0) - 1);
  counts[next] = (counts[next] ?? 0) + 1;
  return { counts };
}
