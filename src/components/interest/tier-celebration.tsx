"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { TierArt } from "@/components/interest/tier-art";
import type { ReferralTier } from "@/lib/interest-list";
import { DUR, EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/** How long the moment holds before it fades on its own. */
const HOLD_MS = 3200;
const ART = 120;

/**
 * The tier-unlock moment: friends joining through your link just crossed 1, 3, 5 or 10.
 * The tier's planet (the sun, at ten) swells in at the centre of the screen with two gold
 * rings rolling out from it, over the tier's name — then it all fades and the tracker's own
 * tier card is left glowing underneath.
 *
 * An announcement, not a dialog: it never takes focus, clicks pass through everywhere but
 * its close button, and Escape or a click anywhere ends it early. The rings are CSS
 * keyframes on transform and opacity (compositor-only, played once); reduced motion keeps
 * the words and drops the movement.
 */
export function TierCelebration({
  tier,
  friends,
  onDone,
}: {
  tier: ReferralTier;
  friends: number;
  onDone: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const hold = window.setTimeout(() => setOpen(false), HOLD_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    // Next tick: the click that caused nothing here must not end it before it starts.
    const arm = window.setTimeout(() => window.addEventListener("pointerdown", onClick), 0);
    return () => {
      window.clearTimeout(hold);
      window.clearTimeout(arm);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onClick);
    };
  }, []);

  // Unmount after the fade.
  useEffect(() => {
    if (open) return;
    const done = window.setTimeout(onDone, 450);
    return () => window.clearTimeout(done);
  }, [open, onDone]);

  const who = friends === 1 ? "A friend" : `${friends} friends`;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="tier-celebration pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-6 transition-opacity duration-[450ms]"
      style={{ opacity: open ? 1 : 0 }}
    >
      {/* The page steps back for the moment: dimmed and softened, with a warm glow behind the
          planet. A blur is fine here — it lives for three seconds, not the page's lifetime. */}
      <div aria-hidden="true" className="absolute inset-0 bg-[#03050c]/80 backdrop-blur-[6px]" />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(242,193,78,0.14),transparent_45%)]"
      />
      <div className="relative flex flex-col items-center text-center">
        <div className="relative flex items-center justify-center" style={{ width: ART * 1.6, height: ART * 1.6 }}>
          {!reduced ? (
            <>
              <span aria-hidden="true" className="tier-celebration-ring absolute rounded-full border border-[#f2c14e]/70" style={{ width: ART, height: ART }} />
              <span
                aria-hidden="true"
                className="tier-celebration-ring absolute rounded-full border border-[#f2c14e]/50"
                style={{ width: ART, height: ART, animationDelay: "0.25s" }}
              />
            </>
          ) : null}
          <motion.span
            className="relative flex items-center justify-center"
            initial={reduced ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={reduced ? { duration: 0 } : SPRING_SOFT}
          >
            <TierArt tierId={tier.id} size={ART} />
          </motion.span>
        </div>
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.base, ease: EASE_HOUSE, delay: reduced ? 0 : 0.25 }}
        >
          <p className="text-xs uppercase tracking-[0.2em] text-[#f2c14e]">Unlocked</p>
          <p className="mt-2 font-[family-name:var(--font-display)] text-[clamp(30px,5vw,44px)] leading-tight text-[#e8f3f1]">
            {tier.label}
          </p>
          <p className="mx-auto mt-2 max-w-[36ch] text-sm leading-relaxed text-[#9aada8]">
            {who} joined through your link. {tier.blurb}
          </p>
        </motion.div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="pointer-events-auto mt-5 flex size-8 items-center justify-center rounded-full border border-[#e8f3f1]/15 text-[#9aada8] transition-colors hover:text-[#e8f3f1]"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body
  );
}
