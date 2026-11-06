import { FREE_STARTER_CREDITS, PLAN_CONFIG, PLAN_LABELS, type Plan } from "@/lib/plans/plan-config";

/**
 * The credits intro's choreography, palette and words — pure and client-safe, so the stage,
 * the canvas and the smoke test all read one source.
 *
 * "A star cluster": the month's credits gather out of a wide field into the plan medallion,
 * Free's starter credits fall in as a second gold shower, the count rolls up, and the screen
 * rests until the viewer continues. Silent by design (no sting).
 */

/** Veil: the stage fades up from the app beneath it. */
export const ENTER_FADE_MS = 300;
/** Stars spawn on a wide ring and ease inward to the medallion's rim. */
export const GATHER: readonly [number, number] = [0, 1800];
/** The medallion forms as the last stars arrive. */
export const SETTLE = 1800;
/** Free only: the starter credits fall from above and seat on the rim. */
export const SHOWER: readonly [number, number] = [2000, 2700];
/** The headline number rolls from 0 to the monthly allowance. */
export const COUNT: readonly [number, number] = [2000, 3000];
/** Subline and the Continue button arrive; ambient drift from here on. */
export const REST = 3200;
/** Clicks and Escape are swallowed before this, then fast-forward to rest. */
export const SKIPPABLE_FROM = 700;
/** Reduced motion: one plain fade, nothing choreographed. */
export const REDUCED_MS = 200;
/** Dismissal fade, veil to gone. */
export const EXIT_MS = 320;

/** Cap on drawn stars: 650 dots read as noise, and the count already says the number. */
export const MAX_STARS = 90;

export type CreditsIntroPhase = "gather" | "settle" | "count" | "rest";

export type CreditsIntroTheme = {
  /** Night field, the same on every plan: this is the sky the stars come out of. */
  field: string;
  /** Medallion body. */
  disc: string;
  /** Rim, stars and the rolled number's accent — the plan's own colour. */
  rim: string;
  rimRgb: string;
  /** The starter shower (Free only). */
  goldRgb: string;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  /** The Continue button: the rim colour as a slab, dark ink on it. */
  button: string;
  buttonInk: string;
};

const NIGHT = {
  field: "#0B1220",
  disc: "#13203A",
  goldRgb: "242, 210, 122",
  ink: "#F7F3E8", // 16:1 on the field
  inkSoft: "#A9B4C9", // 8.6:1
  inkFaint: "#7D8AA5", // 5.3:1 — still AA, it carries the skip hint
  buttonInk: "#0B1220",
};

/** Fixed hexes, not theme tokens: the stage replaces the app, it does not sit in it. */
const RIMS: Record<Plan, { rim: string; rimRgb: string }> = {
  free: { rim: "#E7C76A", rimRgb: "231, 199, 106" },
  orbit: { rim: "#8CC6FF", rimRgb: "140, 198, 255" },
  max: { rim: "#F2C14E", rimRgb: "242, 193, 78" },
  lifetime: { rim: "#D5DCE6", rimRgb: "213, 220, 230" },
};

export function creditsIntroTheme(plan: Plan): CreditsIntroTheme {
  const { rim, rimRgb } = RIMS[plan];
  return { ...NIGHT, rim, rimRgb, button: rim };
}

export type CreditsIntroNumbers = {
  monthlyCredits: number;
  /** Unspent starter credits (Free); 0 elsewhere. */
  starterCredits: number;
  /** When the monthly allowance next refills, ISO. */
  resetsAt: string | null;
  /** "About N answers" from measured cost, when there is enough history to say it. */
  answers: number | null;
};

export type CreditsIntroCopy = {
  kicker: string;
  /** The rolled number. */
  monthly: number;
  /** After the number: "credits a month". */
  unit: string;
  /** Free's second line, "+ 25 to start"; null elsewhere. */
  starter: string | null;
  subline: string;
  footnote: string;
  ariaLabel: string;
};

/** "November 1" — fixed locale and UTC, so server and client agree. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export function creditsIntroCopy(plan: Plan, n: CreditsIntroNumbers): CreditsIntroCopy {
  const starter = plan === "free" && n.starterCredits > 0 ? `+ ${n.starterCredits} to start` : null;
  const parts = [
    PLAN_LABELS[plan],
    n.resetsAt ? `refills ${day(n.resetsAt)}` : null,
    n.answers ? `about ${n.answers.toLocaleString("en-US")} answers` : null,
  ].filter(Boolean);
  const unit = plan === "lifetime" ? "credits a month, now included" : "credits a month";
  return {
    kicker: "Orbit now includes AI",
    monthly: n.monthlyCredits,
    unit,
    starter,
    subline: parts.join(" · "),
    footnote: "Spent on Orbit’s keys. Your own API key never uses credits.",
    ariaLabel: `Your plan now includes ${n.monthlyCredits} AI credits a month${starter ? `, plus ${n.starterCredits} to start` : ""}`,
  };
}

/** What the dev preview draws: the plan's real allowance, a plausible refill and estimate. */
export function previewNumbers(plan: Plan): CreditsIntroNumbers {
  const monthly = PLAN_CONFIG[plan].monthlyCredits ?? 0;
  const next = new Date();
  next.setUTCMonth(next.getUTCMonth() + 1, 1);
  return {
    monthlyCredits: monthly,
    starterCredits: plan === "free" ? FREE_STARTER_CREDITS : 0,
    resetsAt: next.toISOString(),
    answers: monthly * 20,
  };
}
