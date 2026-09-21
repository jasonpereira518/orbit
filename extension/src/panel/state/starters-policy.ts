import type { MeResponse, StartersDegradedReason } from "@contract";

/**
 * Should the panel ask for AI opening lines, and if not, why not?
 *
 * - The plan comes first. A v2 server says whether AI lines are in this plan;
 *   when they aren't, the call would only return the same heuristics while
 *   spending a slot of the per-minute AI budget that page reading shares.
 * - Then the key: AI runs on the user's own provider key.
 * - A v1 server reports no entitlements, and absent is "unknown", never
 *   "locked" — the key is then the only question, as it always was.
 */
export function startersPolicy(
  me: Pick<MeResponse, "capabilities" | "entitlements">
): { fetchAi: boolean; reason: StartersDegradedReason | null } {
  if (me.entitlements?.features.starters === false) {
    return { fetchAi: false, reason: "plan" };
  }
  if (!me.capabilities.hasAiKey) return { fetchAi: false, reason: "no_api_key" };
  return { fetchAi: true, reason: null };
}
