/**
 * Every relationship score's name, in one place. Strength is the 1–5 rating you give,
 * Closeness the computed %, Orbit the Inner/Mid/Outer tier, Health how the conversation is
 * going. Graph rings (by Strength) have their own names so "Inner orbit" only ever means
 * the tier. Copy only: no scoring, storage or URL params depend on these strings.
 */
export const STRENGTH_LABEL = "Strength";
export const CLOSENESS_LABEL = "Closeness";
export const ORBIT_LABEL = "Orbit";
export const HEALTH_LABEL = "Health";

export const ORBIT_TIER_LABELS = { inner: "Inner orbit", mid: "Mid orbit", outer: "Outer orbit" } as const;
export const ORBIT_TIER_SHORT = { inner: "Inner", mid: "Mid", outer: "Outer" } as const;

export const RING_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  5: "Core",
  4: "Close",
  3: "Middle",
  2: "Far",
  1: "Deep space",
};
