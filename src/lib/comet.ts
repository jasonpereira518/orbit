import { daysAgo } from "@/lib/duplicates";

/**
 * Days without contact before someone becomes a red comet on the map.
 * Very strict — only long-dormant relationships (1 year+).
 */
export const COMET_DORMANT_DAYS = 365;

/**
 * True when a contact is drifting away (red comet).
 * Requires a known last interaction that is very old — never-touched
 * contacts are not treated as comets.
 */
export function isCometContact(
  lastInteractionAt: Date | string | null | undefined
): boolean {
  if (!lastInteractionAt) return false;
  return daysAgo(lastInteractionAt) >= COMET_DORMANT_DAYS;
}
