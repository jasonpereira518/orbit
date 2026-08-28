"use client";

import { AnimatePresence, motion } from "motion/react";
import { CARD_FLIGHT_MS, CARD_STAGGER_MS } from "@/lib/celebration/choreography";
import type { CelebrationPhase } from "@/lib/celebration/choreography";
import type { TierTheme } from "@/lib/celebration/tier-theme";
import { HERO_LOGO_PX, cardFlight } from "@/lib/celebration/stage-layout";
import type { StageLayout } from "@/lib/celebration/stage-layout";
import { EASE_HOUSE } from "@/lib/motion";
import { OrbitLogo } from "@/components/orbit-logo";

/**
 * The DOM half of the celebration: kicker, metallic headline, perk cards on
 * their orbital flights, the finale mark, dismiss button. The canvas behind
 * it owns the sky; this file owns the words.
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

export function CelebrationContent({
  theme,
  phase,
  collapsed,
  skipped,
  layout,
  onDismiss,
}: {
  theme: TierTheme;
  phase: CelebrationPhase;
  collapsed: boolean;
  skipped: boolean;
  layout: StageLayout;
  onDismiss: () => void;
}) {
  const slammed = phase !== "accrete";
  const cascading = phase === "cascade" || phase === "finale" || phase === "rest";
  const finale = phase === "finale" || phase === "rest";
  const n = theme.perks.length;
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

      {/* The name, in tier metal. */}
      {slammed && (
        <div
          className="absolute inset-x-0 px-6 text-center"
          style={{ top: layout.headlineTop }}
        >
          <motion.h1
            key={`headline-${played}`}
            initial={skipped ? false : { scale: 1.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ ...ENTRY_SPRING, opacity: { duration: 0.09 } }}
            className="inline-block whitespace-nowrap bg-clip-text font-[family-name:var(--font-display)] font-semibold uppercase leading-none tracking-tight text-transparent"
            style={{
              fontSize: layout.narrow
                ? "clamp(1.9rem, 8.5vw, 2.5rem)"
                : "clamp(2.5rem, 5vw, 4rem)",
              backgroundImage: metalGradient,
              filter: `drop-shadow(0 2px 28px rgba(${theme.glowRgb}, 0.45))`,
            }}
          >
            {theme.name}
          </motion.h1>
        </div>
      )}

      {/* Perk cards. Desktop: orbital flights into two flanking columns.
          Narrow: a stacked list with short slides — off-screen flights on a
          phone strand cards mid-air on dropped frames. */}
      {cascading &&
        (layout.narrow ? (
          <ul
            className="absolute inset-x-6 flex flex-col gap-1.5"
            style={{ top: layout.headlineTop + 44 }}
          >
            {theme.perks.map((perk, i) => (
              <motion.li
                key={`${played}-${perk}`}
                initial={skipped ? false : { opacity: 0, y: 22, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  ...ENTRY_SPRING,
                  delay: skipped ? 0 : (i * CARD_STAGGER_MS) / 1000,
                  opacity: {
                    duration: 0.09,
                    delay: skipped ? 0 : (i * CARD_STAGGER_MS) / 1000,
                  },
                }}
                className="flex items-center gap-2.5 rounded-xl border px-3 py-2 backdrop-blur-md"
                style={{
                  borderColor: `rgba(${theme.glowRgb}, 0.35)`,
                  backgroundColor: `rgba(${theme.deepRgb}, 0.55)`,
                }}
              >
                <PerkDot theme={theme} />
                <span className="text-xs text-white/90">{perk}</span>
              </motion.li>
            ))}
          </ul>
        ) : (
          <ul className="absolute inset-0">
            {theme.perks.map((perk, i) => {
              const slot = layout.cardSlot(i, n);
              const flight = cardFlight(layout, i, n);
              const delay = skipped ? 0 : (i * CARD_STAGGER_MS) / 1000;
              return (
                <motion.li
                  key={`${played}-${perk}`}
                  className="absolute flex items-center gap-3 rounded-xl border px-4 py-2.5 backdrop-blur-md"
                  style={{
                    left: slot.x - layout.cardWidth / 2,
                    top: slot.y - 24,
                    width: layout.cardWidth,
                    borderColor: `rgba(${theme.glowRgb}, 0.35)`,
                    backgroundColor: `rgba(${theme.deepRgb}, 0.55)`,
                  }}
                  initial={
                    skipped
                      ? false
                      : {
                          x: flight.sx - flight.ex,
                          y: flight.sy - flight.ey,
                          opacity: 0,
                          scale: 0.85,
                        }
                  }
                  animate={
                    skipped
                      ? { x: 0, y: 0, opacity: 1, scale: 1 }
                      : {
                          x: [flight.sx - flight.ex, flight.mx - flight.ex, 0],
                          y: [flight.sy - flight.ey, flight.my - flight.ey, 0],
                          opacity: [0, 1, 1],
                          scale: [0.85, 0.96, 1],
                        }
                  }
                  transition={{
                    duration: skipped ? 0 : CARD_FLIGHT_MS / 1000,
                    times: [0, 0.55, 1],
                    ease: EASE_HOUSE,
                    delay,
                    opacity: { duration: 0.12, delay },
                  }}
                >
                  <PerkDot theme={theme} />
                  <span className="text-sm leading-snug text-white/90">{perk}</span>
                </motion.li>
              );
            })}
          </ul>
        ))}

      {/* Finale: the star has contracted into the mark; its plan ring is
          being lit by the canvas sweep around this exact spot. */}
      {finale && (
        <motion.div
          key={`logo-${played}`}
          className="absolute"
          style={{
            left: layout.cx - HERO_LOGO_PX / 2,
            top: layout.cy - HERO_LOGO_PX / 2,
          }}
          initial={skipped ? false : { opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...ENTRY_SPRING, delay: skipped ? 0 : 0.15, opacity: { duration: 0.2, delay: skipped ? 0 : 0.15 } }}
        >
          <OrbitLogo size="hero" plan={theme.plan} />
        </motion.div>
      )}
      {finale && (
        <motion.p
          key={`welcome-${played}`}
          className={
            layout.narrow
              ? "absolute inset-x-6 bottom-28 text-center text-sm text-white/80"
              : "absolute inset-x-0 px-6 text-center text-base text-white/80"
          }
          style={layout.narrow ? undefined : { top: layout.headlineTop + 110 }}
          initial={skipped ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE_HOUSE, delay: skipped ? 0 : 0.4 }}
        >
          {theme.welcome}
        </motion.p>
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

function PerkDot({ theme }: { theme: TierTheme }) {
  return (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full"
      style={{
        backgroundColor: theme.metal.sheen,
        boxShadow: `0 0 12px 3px rgba(${theme.glowRgb}, 0.7)`,
      }}
    />
  );
}
