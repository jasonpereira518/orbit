"use client";

import { useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";
import type { PlanPrice } from "@/lib/plan-copy";

/**
 * The price is the one thing on this page that changes under the visitor's hand, so the
 * change itself is worth explaining: switching to annual does not swap one string for
 * another, it *raises* the number. Every character keeps its own slot and only the
 * characters that actually differ move — glyphs travel up when the price rises and down
 * when it falls, smeared with a little blur so the travel reads as speed rather than as
 * a crossfade. `$5` -> `$50` therefore reads as the price gaining a digit, with the `$5`
 * sitting perfectly still.
 *
 * Two constraints shape this:
 *
 *  1. The price must be legible in the first painted frame. Nothing starts at opacity 0
 *     until the visitor has actually toggled the period (`moved`), so a throttled or
 *     backgrounded tab still paints a readable price. This is the same reason the tier
 *     cards give the price no entrance animation.
 *  2. Exiting glyphs linger in the DOM mid-transition, which would garble the
 *     accessibility tree, so the visual layer is hidden from assistive tech and the price
 *     is announced once from a plain sr-only string.
 */

/** Arrivals decelerate; departures leave faster than they came. */
const ARRIVE: Transition = { duration: 0.36, ease: [0.16, 1, 0.3, 1] };
const DEPART: Transition = { duration: 0.22, ease: [0.4, 0, 0.85, 1] };

/** Percentages of the glyph's own height, so travel scales with the type size. */
const GLYPH_TRAVEL = 62;
const LABEL_TRAVEL = 45;

function magnitude(amount: string) {
  const value = Number.parseFloat(amount.replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? value : 0;
}

export function PlanPriceDisplay({ price }: { price: PlanPrice }) {
  const reduced = useReducedMotion();

  // Adjusting state during render (rather than in an effect) keeps the direction in the
  // same commit as the value it describes, so the first animated frame already knows
  // which way the number went.
  const [previous, setPrevious] = useState(price);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [moved, setMoved] = useState(false);

  if (previous !== price) {
    setDirection(magnitude(price.amount) >= magnitude(previous.amount) ? 1 : -1);
    setPrevious(price);
    setMoved(true);
  }

  const travel = reduced ? 0 : GLYPH_TRAVEL;
  const labelTravel = reduced ? 0 : LABEL_TRAVEL;
  const smear = reduced ? "blur(0px)" : "blur(6px)";

  return (
    <div>
      <p className="sr-only">
        {price.amount} {price.cadence}
        {price.footnote ? `. ${price.footnote}` : ""}
      </p>

      <p aria-hidden="true" className="flex items-baseline gap-1.5">
        {/* `relative` anchors the glyphs that popLayout lifts out of flow while they
            leave; `tabular-nums` keeps every slot the same width so a digit swapping in
            place never twitches the ones beside it. */}
        <span className="relative flex font-[family-name:var(--font-display)] text-[42px] leading-none tracking-tight tabular-nums text-[#e8f3f1]">
          <AnimatePresence initial={false} mode="popLayout">
            {price.amount.split("").map((char, index) => (
              // Keying on slot *and* character means an unchanged glyph is never
              // remounted, so it holds still while its neighbours roll.
              <motion.span
                key={`${index}-${char}`}
                initial={
                  moved
                    ? { y: `${direction * travel}%`, opacity: 0, filter: smear }
                    : false
                }
                animate={{ y: "0%", opacity: 1, filter: "blur(0px)" }}
                exit={{
                  y: `${-direction * travel}%`,
                  opacity: 0,
                  filter: smear,
                  transition: DEPART,
                }}
                transition={ARRIVE}
              >
                {char}
              </motion.span>
            ))}
          </AnimatePresence>
        </span>

        {/* Position-only layout animation: the label slides across as the number gains or
            loses a digit, without motion scaling the text to do it. */}
        <motion.span
          layout="position"
          transition={ARRIVE}
          className="relative text-sm text-[#9aada8]"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={price.cadence}
              className="inline-block whitespace-nowrap"
              initial={moved ? { y: `${direction * labelTravel}%`, opacity: 0 } : false}
              animate={{ y: "0%", opacity: 1 }}
              exit={{
                y: `${-direction * labelTravel}%`,
                opacity: 0,
                transition: DEPART,
              }}
              transition={ARRIVE}
            >
              {price.cadence}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      </p>

      {/* The card already reserves this line's height, so the footnote arrives without
          shifting the tagline beneath it. */}
      <AnimatePresence initial={false} mode="wait">
        {price.footnote && (
          <motion.p
            key={price.footnote}
            aria-hidden="true"
            className="mt-1.5 text-sm text-[#f2c14e]"
            initial={moved ? { opacity: 0, y: reduced ? 0 : 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : -6, transition: DEPART }}
            transition={ARRIVE}
          >
            {price.footnote}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
