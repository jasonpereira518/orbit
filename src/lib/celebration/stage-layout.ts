/**
 * The one geometry both celebration renderers share. The canvas draws the
 * emblem from these numbers; the DOM seats the lockup, the perks and the
 * welcome line on the same ones. Both call
 * `stageLayout(window.innerWidth, window.innerHeight)` — the function is
 * pure, so agreement is guaranteed.
 *
 * The emblem's radius is DERIVED from the leftover height rather than picked.
 * A 220–320px emblem plus a two-line lockup plus six perks plus a bottom-
 * pinned button does not fit a 700px window under any hand-chosen constant,
 * so the fit stops being a hope and becomes an identity: measure the rigid
 * parts, squeeze the compressible gaps, and give the emblem what is left.
 *
 * Type sizes are clamped HERE rather than in CSS `clamp()`. The arithmetic
 * below can only be honest if it budgets with the numbers the DOM actually
 * renders, and the stage already re-runs this on every resize. (The
 * reduced-motion still keeps CSS `clamp()` — it scrolls, so it has no budget
 * to honour.)
 */

export const NARROW_BREAKPOINT = 640;

/** `OrbitLogo size="hero"`. MUST NOT CHANGE — `target.size / HERO_LOGO_PX`
 * is the handoff flight's scale factor. */
export const HERO_LOGO_PX = 96;

/**
 * Mirrors `MAX_PERKS`. Deliberately a local constant rather than a parameter:
 * the canvas calls `stageLayout()` independently of the DOM, and a parameter
 * it could default differently is precisely how the two halves drift apart.
 * Lifetime (5 perks) gets a little unclaimed slack, which the centring
 * absorbs; on wide layouts 5 and 6 perks are both three grid rows anyway.
 */
const BUDGET_PERKS = 6;

/** Leadings, mirroring the styles in `celebration-content.tsx`. These two
 * files have to be edited together. */
const WORD_LEADING = 0.85;
/**
 * Measured layout width of "UNLOCKED!" set in Outfit Black, in ems — taken
 * from `getBoundingClientRect()` in the browser (9.9), rounded up for margin.
 * It covers the nine glyphs, the inline padding that catches the skew's
 * overhang, and the outline's stroke at each end. The word's size is derived
 * from this so it cannot overflow, which no width-fraction guess achieved:
 * the first attempt assumed 8em and ran 15px off both edges of a 375px phone.
 */
const WORD_EM = 10.2;
const PERK_LEADING = 1.375;
const WELCOME_LEADING = 1.5;

/** The bottom bar: a 40px inset (`max(2.5rem, safe-area)` — the largest iOS
 * bottom inset is 34px, so 2.5rem always wins) plus the button box plus air. */
const BOTTOM_RESERVE = { narrow: 108, wide: 116 };
const TOP_MIN = { narrow: 28, wide: 40 };
/** The emblem shrinks to here before the gaps start squeezing. */
const EMBLEM_SOFT = { narrow: 64, wide: 88 };
/** Below this the composition is over budget and says so via `cramped`. */
const EMBLEM_HARD = { narrow: 44, wide: 56 };

export type StageLayout = {
  narrow: boolean;
  width: number;
  height: number;
  /** Emblem centre. */
  cx: number;
  cy: number;
  /** Emblem radius. */
  emblemR: number;
  /** Top of the in-flow column: caps line, word, perks, welcome. */
  lockupTop: number;
  columnWidth: number;
  /** The stack cannot seat at this size; the welcome line is dropped. */
  cramped: boolean;
  capsPx: number;
  wordPx: number;
  perkPx: number;
  welcomePx: number;
  perkPadY: number;
  perkGapY: number;
  gapCaps: number;
  gapPerks: number;
  gapWelcome: number;
};

function clamp(min: number, v: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function stageLayout(width: number, height: number): StageLayout {
  const narrow = width < NARROW_BREAKPOINT;
  const key = narrow ? "narrow" : "wide";
  const cx = width / 2;
  const columnWidth = narrow ? width - 48 : Math.min(width * 0.8, 720);

  const capsPx = narrow ? clamp(11, width * 0.034, 14) : clamp(13, width * 0.011, 17);
  // Capped against the VIEWPORT rather than the column: the word is allowed
  // to run wider than the perk column (it is the hero), but never off the
  // screen. Dividing by the measured ratio makes the fit structural instead
  // of a coefficient that happened to work at one width.
  const wordPx = Math.min(
    narrow ? clamp(30, width * 0.128, 68) : clamp(48, width * 0.064, 104),
    (width - (narrow ? 32 : 64)) / WORD_EM,
  );
  const perkPx = narrow ? 13 : 14;
  const welcomePx = narrow ? 14 : 16;
  const perkPadY = narrow ? 5 : 6;
  const perkGapY = narrow ? 4 : 6;

  // The word sits hard under the caps line — one proportional gap, not a
  // breakpoint pair. Do not "fix" this upward; the tightness is the lockup.
  const gapCaps = Math.round(wordPx * 0.065);

  let gapEmblem = narrow ? 28 : 40;
  let gapPerks = narrow ? 24 : 32;
  let gapWelcome = narrow ? 20 : 28;

  const lockupH = capsPx + gapCaps + wordPx * WORD_LEADING;
  const perkRowH = perkPx * PERK_LEADING + perkPadY * 2;
  const perkRows = narrow ? BUDGET_PERKS : Math.ceil(BUDGET_PERKS / 2);
  const perksH = perkRows * perkRowH + (perkRows - 1) * perkGapY;
  // Narrow wraps the longer welcome to two lines (Lifetime's is 60 chars).
  const welcomeH = (narrow ? 2 : 1) * welcomePx * WELCOME_LEADING;

  const topMin = TOP_MIN[key];
  const avail = height - topMin - BOTTOM_RESERVE[key];
  const softR = EMBLEM_SOFT[key];

  // Gaps are the compressible part of the stack; type is not. On a short
  // window squeeze the gaps before letting the emblem fall below its soft
  // floor — a cramped composition beats a small emblem.
  const gapsTotal = gapEmblem + gapPerks + gapWelcome;
  const rigid = lockupH + perksH + welcomeH;
  const squeeze = clamp(0.55, (avail - rigid - 2 * softR) / gapsTotal, 1);
  gapEmblem = Math.round(gapEmblem * squeeze);
  gapPerks = Math.round(gapPerks * squeeze);
  gapWelcome = Math.round(gapWelcome * squeeze);
  const belowH = gapEmblem + lockupH + gapPerks + perksH + gapWelcome + welcomeH;

  const budgetR = (avail - belowH) / 2;
  const emblemR = narrow
    ? clamp(EMBLEM_HARD.narrow, Math.min(width * 0.26, budgetR), 120)
    : clamp(EMBLEM_HARD.wide, Math.min(width * 0.11, budgetR), 160);

  const cramped = budgetR < EMBLEM_HARD[key];

  const slack = Math.max(0, avail - (emblemR * 2 + belowH));
  const cy = topMin + slack / 2 + emblemR;
  const lockupTop = cy + emblemR + gapEmblem;

  return {
    narrow,
    width,
    height,
    cx,
    cy,
    emblemR,
    lockupTop,
    columnWidth,
    cramped,
    capsPx,
    wordPx,
    perkPx,
    welcomePx,
    perkPadY,
    perkGapY,
    gapCaps,
    gapPerks,
    gapWelcome,
  };
}

/**
 * The app's own logo, as a flight target for the finale handoff.
 *
 * Both the sidebar (desktop) and the mobile header mark carry
 * `data-app-logo`; only one of them is ever laid out, so the visible one is
 * the one with a real box. Returns null when neither is — the caller then
 * dismisses with a plain fade rather than flying the mark into a corner.
 */
export function findAppLogoTarget(): { cx: number; cy: number; size: number } | null {
  const marks = document.querySelectorAll<HTMLElement>("[data-app-logo]");
  for (const mark of marks) {
    const rect = mark.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      size: rect.width,
    };
  }
  return null;
}
