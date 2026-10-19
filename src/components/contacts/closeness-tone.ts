import type { Tone } from "@/lib/tone";

/**
 * The closeness tier, as a status tone.
 *
 * The list coloured its tier chip at one alpha, the profile drew it neutral grey, and the
 * graph's inspect panel used a five-band palette ramp. One map, built on the semantic
 * tones, so the same person reads the same everywhere: Inner = accent, Mid = info,
 * Outer = neutral.
 */
export type ClosenessTier = "inner" | "mid" | "outer";

export const CLOSENESS_TIER_TONE: Record<ClosenessTier, Tone> = {
  inner: "accent",
  mid: "info",
  outer: "neutral",
};

export const CLOSENESS_TIER_LABEL: Record<ClosenessTier, string> = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
};
