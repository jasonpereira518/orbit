/**
 * Everything tier-specific the celebration renders from.
 *
 * The stage is an always-dark takeover, so these are FIXED brand hexes
 * (`--brand-pro` blue, the landing gold), not the theme-aware `--tier-*`
 * tokens — the same rule the pricing cards and the logo ring follow. The
 * whole screen must read as the tier colour: even the space backdrop and its
 * nebulae are re-hued per tier, and the vignette darkens toward tier-black,
 * never neutral black.
 */

import { PLAN_LABELS, type Plan } from "@/lib/plan-limits";
import { planCopy } from "@/lib/plan-copy";

export type PaidPlan = Extract<Plan, "orbit" | "lifetime">;

export type TierNebula = {
  /** Fractions of the viewport, matching `NEBULAE` in `sky-palette.ts`. */
  x: number;
  y: number;
  rx: number;
  ry: number;
  rot: number;
  rgb: string;
  a: number;
};

export type TierTheme = {
  plan: PaidPlan;
  /** "Orbit Pro" / "Orbit Lifetime" — the render uppercases for the slam. */
  name: string;
  /** Fixed brand hex, for DOM accents on the dark stage. */
  accent: string;
  /** `r, g, b` triplet for particles, glow, and shockwaves. */
  glowRgb: string;
  /** Hotter near-white tint for the star's centre and ejecta heads. */
  coreRgb: string;
  /** Metallic headline gradient, sheen to shadow. */
  metal: { sheen: string; hi: string; lo: string };
  /** Tier-tinted deep-space radial stops, centre outward. */
  space: readonly { at: number; color: string }[];
  /** Terminal space colour — the stage background and vignette corner. */
  deep: string;
  /** `deep` as an `r, g, b` triplet, for translucent card fills. */
  deepRgb: string;
  nebulae: readonly TierNebula[];
  kicker: string;
  welcome: string;
  /** What the cascade shows. */
  perks: string[];
};

/** Cards beyond this stop being rewards and start being a terms sheet. */
export const MAX_PERKS = 6;

/** Same composition as `NEBULAE` in `sky-palette.ts` — a large cloud behind
 * the upper left, a counterweight lower right, a faint one low centre — so
 * the tinted sky keeps the house sky's balance while changing its hue. */
const NEBULA_SLOTS = [
  { x: 0.16, y: 0.24, rx: 0.46, ry: 0.3, rot: -0.35 },
  { x: 0.84, y: 0.72, rx: 0.42, ry: 0.26, rot: 0.42 },
  { x: 0.52, y: 1.02, rx: 0.34, ry: 0.2, rot: 0.1 },
] as const;

const THEMES: Record<PaidPlan, TierTheme> = {
  orbit: {
    plan: "orbit",
    name: PLAN_LABELS.orbit,
    accent: "#599de7",
    glowRgb: "142, 196, 245",
    coreRgb: "234, 244, 255",
    metal: { sheen: "#eaf4ff", hi: "#8ec4f5", lo: "#5b9de6" },
    space: [
      { at: 0, color: "#12203f" },
      { at: 0.42, color: "#0b1730" },
      { at: 0.72, color: "#060d1e" },
      { at: 1, color: "#040814" },
    ],
    deep: "#040814",
    deepRgb: "4, 8, 20",
    nebulae: [
      { ...NEBULA_SLOTS[0], rgb: "89, 157, 231", a: 0.14 },
      { ...NEBULA_SLOTS[1], rgb: "70, 120, 220", a: 0.1 },
      { ...NEBULA_SLOTS[2], rgb: "120, 190, 240", a: 0.07 },
    ],
    kicker: "A new star is forming",
    welcome: "Welcome to Orbit Pro. The whole sky is yours.",
    perks: planCopy("orbit").features.slice(0, MAX_PERKS),
  },
  lifetime: {
    plan: "lifetime",
    name: PLAN_LABELS.lifetime,
    accent: "#f2c14e",
    glowRgb: "247, 209, 95",
    coreRgb: "255, 246, 218",
    metal: { sheen: "#fff6da", hi: "#f7d15f", lo: "#e0a52e" },
    space: [
      { at: 0, color: "#2b1c08" },
      { at: 0.42, color: "#1d1305" },
      { at: 0.72, color: "#120b03" },
      { at: 1, color: "#0a0602" },
    ],
    deep: "#0a0602",
    deepRgb: "10, 6, 2",
    nebulae: [
      { ...NEBULA_SLOTS[0], rgb: "242, 193, 78", a: 0.13 },
      { ...NEBULA_SLOTS[1], rgb: "224, 140, 50", a: 0.09 },
      { ...NEBULA_SLOTS[2], rgb: "250, 220, 130", a: 0.06 },
    ],
    kicker: "A star ignites, permanently",
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
