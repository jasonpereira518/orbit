/**
 * Everything tier-specific the celebration renders from.
 *
 * The stage is a bright, flat, saturated takeover — a struck emblem on a
 * colour field — so these are FIXED brand-derived hexes, not the theme-aware
 * `--tier-*` tokens (the same rule the pricing cards and the logo ring
 * follow). Nothing here is theme-reactive: the celebration looks identical in
 * light and dark mode, because it replaces the app rather than sitting in it.
 *
 * Two rules this file exists to enforce:
 *
 * 1. `ink` is DARK on both tiers and is used at FULL OPACITY. Body copy on a
 *    saturated field is exactly where `text-white/70` designs rot — the
 *    resulting ratio silently depends on the field behind it. `inkSoft` and
 *    `inkFaint` are measured values, never opacities of `ink`.
 * 2. The emblem must separate from its own field. Lifetime does it by hue
 *    (warm gold on orange is a value step); Pro does it by BOTH value and
 *    saturation — a desaturated blue-steel coin on a vivid blue field. A
 *    saturated blue coin would dissolve into the ground.
 */

import { PLAN_LABELS, type Plan } from "@/lib/plan-limits";
import { planCopy } from "@/lib/plan-copy";

export type PaidPlan = Extract<Plan, "orbit" | "lifetime">;

/** The flat colour field. There is no black anywhere in the celebration. */
export type FlatField = {
  /** The radial hotspot, centred behind the emblem rather than on the screen. */
  hot: string;
  /** The plateau. Most of the screen is this colour. */
  mid: string;
  /** The rim, before the vignette multiplies over it. */
  edge: string;
  /** Multiplied into the vignette and into the emblem's seat shadow. */
  vignette: string;
  midRgb: string;
  vignetteRgb: string;
};

/**
 * Flat struck metal: discrete tones, never interpolated. Every tonal change
 * on the emblem is a path boundary, not a gradient stop.
 */
export type FacetRamp = {
  highlight: string;
  light: string;
  base: string;
  shadow: string;
  deep: string;
  /** The hard outline. Without it a struck shape dissolves into a saturated
   * field — this is what keeps the emblem reading as a sticker. */
  contour: string;
  /** The plan ring, lit by the finale sweep — the ring the sidebar logo wears. */
  ringLit: string;
};

export type TierTheme = {
  plan: PaidPlan;
  /** "Orbit Pro" / "Orbit Lifetime" — the lockup uppercases it. */
  name: string;
  /** Fixed brand hex, kept for anything that needs the tier's own colour. */
  accent: string;
  field: FlatField;
  emblem: FacetRamp;
  /** Body copy on the field. Dark, full opacity, AA on both tiers. */
  ink: string;
  inkRgb: string;
  /** Secondary copy (the welcome line). Measured, not derived. */
  inkSoft: string;
  /** The skip hint only. Quieter, and honestly decorative-adjacent. */
  inkFaint: string;
  /** The perk-row slab. Must be the emblem's lightest facet, NOT a shade of
   * the field — a chip one step off its own ground is invisible, which is
   * exactly how the first pass failed. */
  chip: string;
  /** The dismiss button, inverted into a dark slab against the bright field. */
  onField: string;
  onFieldInk: string;
  /** Sparks, confetti, shockwaves. */
  sparkRgb: string;
  /** The strike flash and the hottest spark heads. */
  coreRgb: string;
  kicker: string;
  welcome: string;
  perks: string[];
};

/** Cards beyond this stop being rewards and start being a terms sheet. */
export const MAX_PERKS = 6;

const THEMES: Record<PaidPlan, TierTheme> = {
  orbit: {
    plan: "orbit",
    name: PLAN_LABELS.orbit,
    accent: "#599de7",
    field: {
      hot: "#5FAEF9",
      mid: "#3384EA",
      edge: "#1D5DBC",
      vignette: "#123F86",
      midRgb: "51, 132, 234",
      vignetteRgb: "18, 63, 134",
    },
    // Desaturated steel: separates from the vivid blue field by saturation as
    // well as value, which is the only way a blue coin survives a blue ground.
    emblem: {
      highlight: "#DCE9F7",
      light: "#A8C0DA",
      base: "#6E88A8",
      shadow: "#3E5476",
      deep: "#24344F",
      contour: "#0C1526",
      ringLit: "#8CC6FF",
    },
    ink: "#04162E", // 4.9:1 on field.mid
    inkRgb: "4, 22, 46",
    inkSoft: "#0B2A52",
    inkFaint: "#16406F",
    chip: "#DCE9F7", // ink on it: 14.9:1
    onField: "#0C1526",
    onFieldInk: "#FFFFFF",
    sparkRgb: "255, 255, 255",
    coreRgb: "234, 244, 255",
    kicker: "Something new is lighting up",
    welcome: "Welcome to Orbit Pro. The whole sky is yours.",
    perks: planCopy("orbit").features.slice(0, MAX_PERKS),
  },
  lifetime: {
    plan: "lifetime",
    name: PLAN_LABELS.lifetime,
    accent: "#f2c14e",
    field: {
      hot: "#FFCE63",
      mid: "#F5A623",
      edge: "#E07C12",
      vignette: "#A85405",
      midRgb: "245, 166, 35",
      vignetteRgb: "168, 84, 5",
    },
    emblem: {
      highlight: "#FFE9AE",
      light: "#F5C264",
      base: "#C97D26",
      shadow: "#8E4E14",
      deep: "#572C08",
      contour: "#3B1C02",
      ringLit: "#FFF4CF",
    },
    ink: "#3B1C02", // 7.7:1 on field.mid
    inkRgb: "59, 28, 2",
    inkSoft: "#5A3208",
    inkFaint: "#7A4A10",
    chip: "#FFE9AE", // ink on it: 12.6:1
    onField: "#3B1C02",
    onFieldInk: "#FFFFFF",
    sparkRgb: "255, 255, 255",
    coreRgb: "255, 250, 236",
    kicker: "This one is yours to keep",
    welcome: "Welcome to Orbit Lifetime. Yours for as long as Orbit exists.",
    perks: planCopy("lifetime").features.slice(0, MAX_PERKS),
  },
};

export function tierTheme(plan: PaidPlan): TierTheme {
  return THEMES[plan];
}

export function isPaidPlan(plan: Plan): plan is PaidPlan {
  return plan === "orbit" || plan === "lifetime";
}
