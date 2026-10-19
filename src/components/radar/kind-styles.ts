import type { RecommendationKind } from "@/lib/radar/types";
import type { Tone } from "@/lib/tone";

/**
 * The kind chip's tone, on the status tokens — the same palette the dashboard's suggestion
 * reasons use (`dashboard/suggestion-row.tsx`), so a colour means one thing on both cards:
 * quiet/dormant is neutral, news is info, something you owe is warning, a fresh opening is
 * accent.
 */
export const KIND_TONES: Record<RecommendationKind, Tone> = {
  prep: "info",
  heads_up: "info",
  follow_up: "warning",
  opportunity: "accent",
  reach_out: "warning",
  reconnect: "neutral",
};
