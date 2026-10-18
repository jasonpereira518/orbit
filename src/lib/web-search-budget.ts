import { webSearchPaused } from "@/lib/ai-access";
import { consumeBucket, isRateLimitedError, RATE_LIMITS, RateLimitedError } from "@/lib/rate-limit";
import { utcDayKey } from "@/lib/timeline-cost";

/**
 * What hosted web search may cost, and the gate `webSearchJson` runs before every search.
 *
 * Each search is a provider fee on top of tokens — Anthropic's is $10 per 1,000 — and in Oct
 * 2026 it was 85% of the bill. Two ceilings, both counted in searches, not calls:
 *  - per account, per calendar month (`RATE_LIMITS.webSearchMonthly`), every feature and key
 *    together, so one account cannot spend everyone's share;
 *  - across Orbit, per UTC day (`RATE_LIMITS.webSearchDaily`): $190 a month, paced daily so a
 *    burst cannot spend the month early.
 * Plus the admin switch (`site_settings.web_search_paused`) that stops it all at once.
 */

/** Searches one dollar buys at Anthropic's $10 per 1,000 — the yardstick for the budget. */
const SEARCHES_PER_USD = 100;
/** Orbit-wide web-search spend that has to last a month (Jason, Oct 17 2026). */
export const WEB_SEARCH_BUDGET_USD_PER_30_DAYS = 190;
/** ÷31, not ÷30: the longest month stays inside the budget too. */
export const WEB_SEARCH_DAILY_CEILING = Math.floor((WEB_SEARCH_BUDGET_USD_PER_30_DAYS * SEARCHES_PER_USD) / 31);
/** The share of an account's month background work may use, so it never starves a click. */
export const WEB_SEARCH_BACKGROUND_SHARE = 0.5;

export const WEB_SEARCH_SCOPE = "web-search";
export const WEB_SEARCH_ALL_SCOPE = "web-search-all";

export function webSearchMonthKey(userId: string, now: Date): string {
  return `${userId}:${now.toISOString().slice(0, 7)}`;
}

function secondsUntil(at: number, now: Date): number {
  return Math.max(1, Math.ceil((at - now.getTime()) / 1000));
}

export function secondsToNextMonth(now: Date): number {
  return secondsUntil(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1), now);
}

function secondsToNextUtcDay(now: Date): number {
  return secondsUntil(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1), now);
}

/** Re-throws a bucket's refusal with the real wait: until the key rolls over, not the window. */
async function consume(scope: string, key: string, retryAfterSec: number, cost = 1): Promise<void> {
  try {
    await consumeBucket(scope, key, scope === WEB_SEARCH_SCOPE ? RATE_LIMITS.webSearchMonthly : RATE_LIMITS.webSearchDaily, cost);
  } catch (err) {
    if (isRateLimitedError(err)) throw new RateLimitedError(scope, retryAfterSec);
    throw err;
  }
}

/**
 * Before a search: refuse if paused or either ceiling is spent, else hold one search. Throws
 * `RateLimitedError`, which every caller already turns into "try again later".
 * ponytail: a refusal by the Orbit-wide bucket leaves the account's one unit spent.
 */
export async function reserveWebSearch(userId: string, now = new Date()): Promise<void> {
  if (await webSearchPaused()) throw new RateLimitedError(WEB_SEARCH_ALL_SCOPE, 3_600);
  await consume(WEB_SEARCH_SCOPE, webSearchMonthKey(userId, now), secondsToNextMonth(now));
  await consume(WEB_SEARCH_ALL_SCOPE, utcDayKey(now), secondsToNextUtcDay(now));
}

/**
 * After a search: charge what it really used beyond the one reserved. Settled on the count,
 * not reserved up front, because OpenAI and Gemini honour no per-call maximum. Never throws —
 * the searches already happened, and a ceiling crossed here refuses the NEXT call.
 * ponytail: a call that searched 0 times still cost its reserved unit.
 */
export async function settleWebSearch(userId: string, searches: number, now = new Date()): Promise<void> {
  const extra = Math.floor(searches) - 1;
  if (extra <= 0) return;
  await Promise.all([
    consume(WEB_SEARCH_SCOPE, webSearchMonthKey(userId, now), 0, extra).catch(() => undefined),
    consume(WEB_SEARCH_ALL_SCOPE, utcDayKey(now), 0, extra).catch(() => undefined),
  ]);
}

/**
 * `max_uses` for an Anthropic `pause_turn` resume. Each resume is a new request that may run
 * `max_uses` searches again, so it gets what is left of the call's budget (never 0, which the
 * API rejects) — a call's ceiling is `maxSearches + 1`, not one full budget per resume.
 */
export function resumeMaxUses(maxSearches: number, used: number): number {
  return Math.max(1, maxSearches - used);
}

/** Searches one Anthropic response ran, from `usage.server_tool_use`. */
export function anthropicSearchCount(response: unknown): number {
  const n = (response as { usage?: { server_tool_use?: { web_search_requests?: unknown } | null } } | null)?.usage
    ?.server_tool_use?.web_search_requests;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
