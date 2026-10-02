/**
 * Pure plan-transition logic for the celebration watcher.
 *
 * The only state is one localStorage key. The watcher writes it BEFORE
 * starting a celebration, which is the entire dedupe story: whichever of the
 * competing feeds (mount compare, fast post-checkout poll, ambient poll,
 * StrictMode's second effect run) arrives second reads `prev === next` and
 * classifies as "same".
 */

import { PLAN_RANK, PLANS, type Plan } from "@/lib/plans/plan-config";
import { LAST_SEEN_PLAN_KEY } from "@/lib/celebration/choreography";

export { PLAN_RANK };

function isPlan(value: string | null): value is Plan {
  return (PLANS as readonly string[]).includes(value ?? "");
}

/** Null on first visit, garbage, or storage-hostile browsers (Safari private
 * mode throws on access — same fallback story as `arrivedByWarp`). */
export function readLastSeenPlan(): Plan | null {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_PLAN_KEY);
    return isPlan(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeLastSeenPlan(plan: Plan) {
  try {
    window.localStorage.setItem(LAST_SEEN_PLAN_KEY, plan);
  } catch {
    // Without storage every visit is a "first visit", which never celebrates —
    // the failure costs a nicety, not a false fanfare.
  }
}

export type UpgradeKind = "first-visit" | "upgrade" | "downgrade" | "same";

export function upgradeKind(prev: Plan | null, next: Plan): UpgradeKind {
  if (prev === null) return "first-visit";
  if (prev === next) return "same";
  return PLAN_RANK[next] > PLAN_RANK[prev] ? "upgrade" : "downgrade";
}
