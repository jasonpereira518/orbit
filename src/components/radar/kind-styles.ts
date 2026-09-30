import type { RecommendationKind } from "@/lib/radar/types";

/** The kind chip's colours, one hue per kind, in the dashboard's pill style. */
export const KIND_STYLES: Record<RecommendationKind, string> = {
  prep: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  heads_up: "bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-200",
  follow_up: "bg-violet-500/15 text-violet-800 dark:text-violet-200",
  opportunity: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  reach_out: "bg-orange-500/15 text-orange-800 dark:text-orange-200",
  reconnect: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
};
