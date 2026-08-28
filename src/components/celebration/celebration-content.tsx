"use client";

import { AnimatePresence, motion } from "motion/react";
import { PERK_STAGGER_MS } from "@/lib/celebration/choreography";
import type { CelebrationPhase } from "@/lib/celebration/choreography";
import type { TierTheme } from "@/lib/celebration/tier-theme";
import { HERO_LOGO_PX } from "@/lib/celebration/stage-layout";
import type { StageLayout } from "@/lib/celebration/stage-layout";
import { EASE_HOUSE } from "@/lib/motion";
import { OrbitLogo } from "@/components/orbit-logo";

/**
 * The DOM half of the celebration: kicker, metallic headline, the perk
 * manifest, the finale mark, the dismiss button. The canvas behind it owns
 * the sky; this file owns the words.
 *
 * Everything below the star lives in ONE absolutely-positioned flow column
 * rather than being placed line by line: a perk that wraps to two lines then
 * pushes the welcome line down instead of landing on top of it.
 *
 * `skipped` means the rest state was reached by a skip rather than by playing
 * through — every staggered entrance REMOUNTS under a `skipped`-keyed `key`
 * and renders `initial={false}`, in final position with no entrance. Without
 * the remount, motion entrances already scheduled with stagger delays keep
 * trailing in after the skip.
 *
 * Everything is `pointer-events-none` except the button: the stage root owns
 * clicks (skip / dismiss).
 */

/** The one hard spring for celebratory entries. */
const ENTRY_SPRING = { type: "spring", stiffness: 620, damping: 30, mass: 0.7 } as const;

/** Softer spring for the manifest — perks are written in, not slammed in. */
const PERK_SPRING = { type: "spring", stiffness: 320, damping: 26, mass: 0.6 } as const;

export function CelebrationContent({
  theme,
  phase,
  collapsed,
  skipped,
  /** The mark has left the stage for the app's own logo; stop drawing it. */
  handoff,
  layout,
  onDismiss,
}: {
  theme: TierTheme;
  phase: CelebrationPhase;
  collapsed: boolean;
  skipped: boolean;
  handoff: boolean;
  layout: StageLayout;
  onDismiss: () => void;
}) {
  const slammed = phase !== "accrete";
  const cascading = phase === "cascade" || phase === "finale" || phase === "rest";
  const finale = phase === "finale" || phase === "rest";
  const played = skipped ? "skipped" : "played";

  const metalGradient = `linear-gradient(180deg, ${theme.metal.sheen} 0%, ${theme.metal.hi} 38%, ${theme.metal.lo} 100%)`;

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* Kicker — consumed by the collapsing core, not faded politely. */}
      <AnimatePresence>
        {phase === "accrete" && !collapsed && (
          <motion.p
            key="kicker"
            className="absolute inset-x-0 text-center text-sm uppercase tracking-[0.3em] text-white/60"
            style={{ top: layout.headlineTop }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.4, duration: 0.6 } }}
            exit={{
              opacity: 0,
              y: layout.cy - layout.headlineTop,
              scale: 0.8,
              transition: { duration: 0.25, ease: EASE_HOUSE },
            }}
          >
            {theme.kicker}
          </motion.p>
        )}
      </AnimatePresence>

      {/* The column: name, manifest, welcome. */}
      {slammed && (
        <div
          className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center"
          style={{ top: layout.headlineTop, width: layout.columnWidth }}
        >
          {/* The name, in tier metal. A geometric sans at heavy weight and
              open tracking — a display serif reads as an invitation, and this
              beat is a trophy. */}
          <motion.h1
            key={`headline-${played}`}
            initial={skipped ? false : { scale: 1.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ ...ENTRY_SPRING, opacity: { duration: 0.09 } }}
            className="whitespace-nowrap bg-clip-text font-[family-name:var(--font-sans)] font-extrabold uppercase leading-none text-transparent"
            style={{
              fontSize: layout.narrow
                ? "clamp(1.75rem, 8vw, 2.375rem)"
                : "clamp(2.5rem, 5vw, 4rem)",
              letterSpacing: layout.narrow ? "0.01em" : "0.02em",
              backgroundImage: metalGradient,
              filter: `drop-shadow(0 2px 28px rgba(${theme.glowRgb}, 0.45))`,
            }}
          >
            {theme.name}
          </motion.h1>

          {/* The manifest. Each perk is written in on its own beat: the
              spark lands, the words resolve out of the tier's own light, and
              a hairline rules itself in underneath. Deliberately not cards —
              chrome around every line turned the reward into a receipt. */}
          {cascading && (
            <ul
              className={
                layout.narrow
                  ? "mt-4 flex w-full flex-col gap-0.5"
                  : "mt-7 grid w-full grid-cols-2 gap-x-8 gap-y-1"
              }
            >
              {theme.perks.map((perk, i) => {
                const delay = skipped ? 0 : (i * PERK_STAGGER_MS) / 1000;
                // Desktop columns converge inward; the narrow list all
                // arrives from the same side, which reads as a list.
                const from = layout.narrow ? -14 : i % 2 === 0 ? -18 : 18;
                return (
                  <motion.li
                    key={`${played}-${perk}`}
                    className="relative flex items-center gap-3 py-1.5"
                    initial={skipped ? false : { opacity: 0, x: from, y: 6 }}
                    animate={{ opacity: 1, x: 0, y: 0 }}
                    transition={{ ...PERK_SPRING, delay }}
                  >
                    <PerkSpark theme={theme} skipped={skipped} delay={delay} />
                    <motion.span
                      className={
                        layout.narrow
                          ? "text-[13px] leading-snug"
                          : "text-sm leading-snug"
                      }
                      initial={skipped ? false : { color: theme.metal.sheen }}
                      animate={{ color: "rgba(255, 255, 255, 0.9)" }}
                      transition={{ duration: 0.7, delay: delay + 0.12 }}
                    >
                      {perk}
                    </motion.span>
                    {/* The rule draws itself under the line, fading out
                        toward the far end so it reads as light, not a border. */}
                    <motion.span
                      aria-hidden
                      className="absolute inset-x-0 bottom-0 h-px origin-left"
                      style={{
                        backgroundImage: `linear-gradient(90deg, rgba(${theme.glowRgb}, 0.55), rgba(${theme.glowRgb}, 0))`,
                      }}
                      initial={skipped ? false : { scaleX: 0, opacity: 0 }}
                      animate={{ scaleX: 1, opacity: 1 }}
                      transition={{
                        duration: 0.45,
                        ease: EASE_HOUSE,
                        delay: delay + 0.06,
                      }}
                    />
                  </motion.li>
                );
              })}
            </ul>
          )}

          {finale && (
            <motion.p
              key={`welcome-${played}`}
              className={
                layout.narrow
                  ? "mt-5 text-center text-sm text-white/80"
                  : "mt-8 text-center text-base text-white/80"
              }
              initial={skipped ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE_HOUSE, delay: skipped ? 0 : 0.4 }}
            >
              {theme.welcome}
            </motion.p>
          )}
        </div>
      )}

      {/* Finale: the star has contracted into the mark; its plan ring is
          being lit by the canvas sweep around this exact spot. Once the
          handoff starts, the flying copy outside the veil owns the mark. */}
      {finale && !handoff && (
        <motion.div
          key={`logo-${played}`}
          className="absolute"
          style={{
            left: layout.cx - HERO_LOGO_PX / 2,
            top: layout.cy - HERO_LOGO_PX / 2,
          }}
          initial={skipped ? false : { opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{
            ...ENTRY_SPRING,
            delay: skipped ? 0 : 0.15,
            opacity: { duration: 0.2, delay: skipped ? 0 : 0.15 },
          }}
        >
          <OrbitLogo size="hero" plan={theme.plan} />
        </motion.div>
      )}

      <div className="absolute inset-x-0 bottom-[max(2.5rem,env(safe-area-inset-bottom))] flex justify-center">
        {phase === "rest" ? (
          <motion.button
            key={`dismiss-${played}`}
            type="button"
            onClick={onDismiss}
            initial={skipped ? false : { opacity: 0, y: 16, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ ...ENTRY_SPRING, opacity: { duration: 0.12 } }}
            className="pointer-events-auto rounded-full px-8 py-3 text-base font-medium shadow-lg outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent active:scale-[0.98]"
            style={{
              color: theme.deep,
              backgroundImage: `linear-gradient(to bottom, ${theme.metal.hi}, ${theme.metal.lo})`,
              boxShadow: `0 10px 34px -10px rgba(${theme.glowRgb}, 0.75)`,
            }}
          >
            Let&apos;s go
          </motion.button>
        ) : (
          (phase === "cascade" || phase === "finale") && (
            <motion.p
              className="text-xs text-white/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.32 }}
            >
              Click anywhere to skip
            </motion.p>
          )
        )}
      </div>
    </div>
  );
}

/** Lands hot and settles — the same idea as the star, three orders of
 * magnitude smaller. */
function PerkSpark({
  theme,
  skipped,
  delay,
}: {
  theme: TierTheme;
  skipped: boolean;
  delay: number;
}) {
  return (
    <motion.span
      aria-hidden
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: theme.metal.sheen }}
      initial={
        skipped
          ? false
          : { scale: 0.2, boxShadow: `0 0 22px 7px rgba(${theme.glowRgb}, 0.9)` }
      }
      animate={{ scale: 1, boxShadow: `0 0 10px 2px rgba(${theme.glowRgb}, 0.6)` }}
      transition={{ ...PERK_SPRING, delay }}
    />
  );
}
