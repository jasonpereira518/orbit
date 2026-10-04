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
 * 1. `ink` is DARK on all three tiers and is used at FULL OPACITY. Body copy on a
 *    saturated field is exactly where `text-white/70` designs rot — the
 *    resulting ratio silently depends on the field behind it. `inkSoft` and
 *    `inkFaint` are measured values, never opacities of `ink`.
 * 2. The emblem must separate from its own field. Max does it by hue (warm
 *    gold on orange is a value step); Pro does it by BOTH value and saturation
 *    — a desaturated blue-steel coin on a vivid blue field; Lifetime by value
 *    alone — near-white highlights and gunmetal shadows on a mid silver field,
 *    since silver on silver has no hue or saturation to spend.
 *
 * Pricing v2 colors: Pro blue, Max the app's gold, Lifetime silver (a Lifetime
 * grant is admin-assigned, and gets the silver version).
 */

import { PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";
import { planCopy } from "@/lib/plan-copy";

export type PaidPlan = Extract<Plan, "orbit" | "max" | "lifetime">;

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
  /** The motion signature of this plan's activation. */
  signature: "orbit" | "flare" | "seal";
  /** "Orbit Pro" / "Orbit Lifetime" — the lockup uppercases it. */
  name: string;
  /** Fixed brand hex, kept for anything that needs the tier's own colour. */
  accent: string;
  field: FlatField;
  emblem: FacetRamp;
  /** Body copy on the field. Dark, full opacity, AA on all three tiers. */
  ink: string;
  inkRgb: string;
  /** Secondary copy (the welcome line). Measured, not derived. */
  inkSoft: string;
  /** The skip hint only. Quieter, and honestly decorative-adjacent. */
  inkFaint: string;
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
    signature: "orbit",
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
    onField: "#0C1526",
    onFieldInk: "#FFFFFF",
    sparkRgb: "255, 255, 255",
    coreRgb: "234, 244, 255",
    kicker: "Something new is lighting up",
    welcome: "Welcome to Orbit Pro. The whole sky is yours.",
    perks: planCopy("orbit").features.slice(0, MAX_PERKS),
  },
  max: {
    plan: "max",
    signature: "flare",
    name: PLAN_LABELS.max,
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
    onField: "#3B1C02",
    onFieldInk: "#FFFFFF",
    sparkRgb: "255, 255, 255",
    coreRgb: "255, 250, 236",
    kicker: "A brighter star is igniting",
    welcome: "Welcome to Orbit Max. Everything Orbit does, at full strength.",
    perks: planCopy("max").features.slice(0, MAX_PERKS),
  },
  lifetime: {
    plan: "lifetime",
    signature: "seal",
    name: PLAN_LABELS.lifetime,
    accent: "#c9d1db",
    field: {
      hot: "#E9EDF2",
      mid: "#C3CBD5",
      edge: "#98A3B1",
      vignette: "#5E6875",
      midRgb: "195, 203, 213",
      vignetteRgb: "94, 104, 117",
    },
    // Silver on silver: the coin separates by VALUE — near-white highlights and gunmetal
    // shadows around a mid silver — because there is no hue or saturation to spend.
    emblem: {
      highlight: "#FFFFFF",
      light: "#E4E8ED",
      base: "#A7B0BC",
      shadow: "#6B7582",
      deep: "#3C444F",
      contour: "#1C2129",
      ringLit: "#FFFFFF",
    },
    ink: "#1C2129", // 9.9:1 on field.mid
    inkRgb: "28, 33, 41",
    inkSoft: "#2D343D",
    inkFaint: "#434C57", // 5.3:1 on field.mid
    onField: "#1C2129",
    onFieldInk: "#FFFFFF",
    sparkRgb: "255, 255, 255",
    coreRgb: "250, 251, 253",
    kicker: "This one is yours to keep",
    welcome: "Welcome to Orbit Lifetime. Yours for as long as Orbit exists.",
    perks: planCopy("lifetime").features.slice(0, MAX_PERKS),
  },
};

export function tierTheme(plan: PaidPlan): TierTheme {
  return THEMES[plan];
}

export function isPaidPlan(plan: Plan): plan is PaidPlan {
  return plan === "orbit" || plan === "max" || plan === "lifetime";
}
