import { PLANS, type Plan } from "@/lib/plans/plan-config";
import { isPaidPlan, type PaidPlan } from "@/lib/celebration/tier-theme";

const KEY_PREFIX = "orbit:last-observed-plan:";

export function downgradeStorageKey(userId: string) {
  return `${KEY_PREFIX}${userId}`;
}

function validPlan(value: string | null): value is Plan {
  return (PLANS as readonly string[]).includes(value ?? "");
}

/** A fresh browser profile seeds silently. Each later paid-to-Free observation
 * is claimed locally before a stage can start, including across same-origin tabs. */
export function observePlanForDowngrade(
  userId: string,
  next: Plan,
  storage?: Pick<Storage, "getItem" | "setItem">,
): PaidPlan | null {
  try {
    const observedStorage = storage ?? window.localStorage;
    const key = downgradeStorageKey(userId);
    const raw = observedStorage.getItem(key);
    const previous = validPlan(raw) ? raw : null;
    if (previous === next) return null;
    observedStorage.setItem(key, next);
    return next === "free" && previous && isPaidPlan(previous) ? previous : null;
  } catch {
    // Storage-hostile browsers cannot establish a reliable prior observation.
    return null;
  }
}

export function downgradePlaybackDecision(
  current: Plan,
  ready: boolean,
): "cancel" | "defer" | "play" {
  if (current !== "free") return "cancel";
  return ready ? "play" : "defer";
}
