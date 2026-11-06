import { createHash } from "node:crypto";

/**
 * Stable holdouts for deciding whether a change did anything, at a user count where a coin-flip
 * A/B test cannot tell you.
 *
 * With a few hundred activated accounts a two-arm test is underpowered for any effect smaller
 * than a large one. What a holdout buys instead is an honest comparison group for a change you
 * are shipping anyway: a fixed slice of accounts that does not get it, chosen by a hash so they
 * stay the same people on every request, every deploy and every instance, with no table to keep
 * in step. Compare the two groups' counts, print the fractions, and do not call a winner below
 * the minimum in `HOLDOUT_MIN_PER_ARM`. The practice is written up in ANALYTICS_PLAN.md §4.2.
 *
 * A holdout is a bucket, not a cookie: it needs the account id and nothing else, and it moves
 * nobody's data anywhere.
 *
 * Usage:
 *
 *   if (!inHoldout(userId, "radar-digest-v2")) { ...the new behaviour... }
 *
 * Register every experiment in `HOLDOUTS` so the console and the digest can say what is
 * running, and so two experiments are never silently stacked on the same funnel stage.
 */

/** Below this many accounts in each arm, report the counts and call nothing. */
export const HOLDOUT_MIN_PER_ARM = 50;

export type Holdout = {
  /** What the change is, in a sentence. */
  description: string;
  /** Percent of accounts who do NOT get the change, 1-50. */
  holdoutPercent: number;
  /** The funnel stage it should move; one running experiment per stage. */
  stage: string;
  /** ISO date the change shipped, so before/after reads have their boundary. */
  startedOn: string;
};

/** Experiments in flight. Empty until one is. */
export const HOLDOUTS: Readonly<Record<string, Holdout>> = {};

/** 0..99, the same for the same (account, flag) forever. */
export function holdoutBucket(userId: string, flag: string): number {
  const digest = createHash("sha256").update(`${flag}:${userId}`).digest();
  // Four bytes is plenty of entropy for a hundred buckets, and modulo bias at 2^32 / 100 is
  // far below anything a sample this small could detect.
  return digest.readUInt32BE(0) % 100;
}

/** Whether this account is held out of `flag` (does NOT get the change). */
export function inHoldout(userId: string, flag: string, percent?: number): boolean {
  const pct = percent ?? HOLDOUTS[flag]?.holdoutPercent;
  if (pct === undefined) return false;
  return holdoutBucket(userId, flag) < Math.max(0, Math.min(50, pct));
}

/**
 * Whether two arms are big enough to say anything about. Pure, so the console and the digest
 * share one rule instead of each choosing their own threshold.
 */
export function holdoutReadable(arm: { treated: number; held: number }): boolean {
  return arm.treated >= HOLDOUT_MIN_PER_ARM && arm.held >= HOLDOUT_MIN_PER_ARM;
}
