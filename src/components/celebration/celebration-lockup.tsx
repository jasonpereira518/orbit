"use client";

import { motion } from "motion/react";
import { EASE_HOUSE } from "@/lib/motion";

/**
 * The two-line lockup: the tier name in small tracked caps, then the verdict
 * in a huge leaning word.
 *
 * Shared by the animated stage and the reduced-motion still, because the two
 * previously drifted — reduced set the name in Fraunces while the animated
 * path used Outfit, so the same event was announced in two typefaces.
 *
 * Sizes arrive as `number | string`: the animated path passes numbers from
 * `stageLayout` (its vertical budget has to be computed from the numbers the
 * DOM will really render), while the still passes CSS `clamp()` strings,
 * which are free and correct there because it scrolls.
 */

/**
 * Outfit ships no italic file and has no `slnt` axis, so the lean is a skew.
 * That is not a compromise here: `UNLOCKED!` is all caps, and at all caps a
 * true italic and an oblique are the same object — there are no lowercase
 * letterform substitutions (single-storey `a`, `f` descender) to miss. The
 * reference is itself an obliqued grotesk.
 *
 * 12° sits between a true geometric-sans italic (~10°) and Blink's synthetic
 * oblique (~14°). Past ~15° Outfit's circular counters (O, C, D) shear far
 * enough to read as broken rather than as leaning.
 */
export const SKEW_DEG = -12;

/** The hard spring the word rides in on. */
const ENTRY_SPRING = { type: "spring", stiffness: 620, damping: 30, mass: 0.7 } as const;

export function CelebrationLockup({
  name,
  capsPx,
  wordPx,
  gapCaps,
  tracking,
  ink,
  outline,
  skipped = false,
  animate = true,
}: {
  name: string;
  capsPx: number | string;
  wordPx: number | string;
  gapCaps: number | string;
  tracking: string;
  /** The caps line's colour — dark ink, which passes on both fields. */
  ink: string;
  /** The word's outline. White type on a saturated field survives on its
   * boundary, not on its luminance, so this is load-bearing. */
  outline: string;
  skipped?: boolean;
  /** The still renders plain elements; nothing competes for `transform`. */
  animate?: boolean;
}) {
  const played = skipped ? "skipped" : "played";

  const capsStyle = {
    fontSize: capsPx,
    lineHeight: 1,
    letterSpacing: tracking,
    color: ink,
    // `letter-spacing` trails the LAST glyph too, so a centred tracked line
    // sits half a tracking-unit left of true centre. Directly above a 92px
    // word that misalignment is visible; pull the trailing gap back off.
    marginRight: `-${tracking}`,
  } as const;

  const wordStyle = {
    fontSize: wordPx,
    fontWeight: 900, // Outfit is variable — 900 costs nothing extra
    lineHeight: 0.85,
    letterSpacing: "-0.015em",
    marginTop: gapCaps,
    // The skew pushes ink past the layout box; defence against any ancestor
    // that ever clips.
    paddingInline: "0.08em",
    transformOrigin: "50% 50%",
    color: "#FFFFFF",
    // `paint-order: stroke` puts the outline UNDER the fill. A centred stroke
    // otherwise eats into the letterform, and with negative tracking each
    // glyph's stroke bites its neighbour — which reads as slashes through
    // the word rather than as an outline around it.
    paintOrder: "stroke",
    WebkitTextStroke: `6px ${outline}`,
    textShadow: `0 4px 0 ${outline}`,
  } as const;

  const capsClass =
    "whitespace-nowrap font-[family-name:var(--font-sans)] font-semibold uppercase";
  const wordClass = "whitespace-nowrap font-[family-name:var(--font-sans)] uppercase";

  if (!animate) {
    return (
      <div className="flex flex-col items-center">
        <p className={capsClass} style={capsStyle}>
          {name}
        </p>
        <h1
          className={wordClass}
          style={{ ...wordStyle, transform: `skewX(${SKEW_DEG}deg)` }}
        >
          Unlocked!
        </h1>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      {/* Both lines mount together and decay differently. Two springs 90ms
          apart inside a full-screen flash and a 380ms shake would read as a
          mis-fire; common onset with different decay is how a real impact
          reads — everything moves at once, the heavy thing moves longer. */}
      <motion.p
        key={`tier-${played}`}
        className={capsClass}
        style={capsStyle}
        initial={skipped ? false : { opacity: 0, scale: 1.06, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: EASE_HOUSE, opacity: { duration: 0.09 } }}
      >
        {name}
      </motion.p>
      <motion.h1
        key={`word-${played}`}
        className={wordClass}
        style={wordStyle}
        // The skew MUST be a motion value, never `transform` in `style`:
        // motion owns this element's transform because it animates `scale`,
        // so a hand-written transform is overwritten on the first frame and
        // the word stands up.
        initial={skipped ? false : { scale: 1.6, opacity: 0, skewX: SKEW_DEG }}
        animate={{ scale: 1, opacity: 1, skewX: SKEW_DEG }}
        transition={{ ...ENTRY_SPRING, opacity: { duration: 0.09 } }}
      >
        Unlocked!
      </motion.h1>
    </div>
  );
}
