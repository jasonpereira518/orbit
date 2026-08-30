"use client";

import { AnimatePresence, motion } from "motion/react";
import { PERK_STAGGER_MS } from "@/lib/celebration/choreography";
import type { CelebrationPhase } from "@/lib/celebration/choreography";
import type { TierTheme } from "@/lib/celebration/tier-theme";
import type { StageLayout } from "@/lib/celebration/stage-layout";
import { EASE_HOUSE } from "@/lib/motion";
import { CelebrationLockup } from "@/components/celebration/celebration-lockup";

/**
 * The DOM half of the celebration: the kicker, the lockup, the perk manifest,
 * the welcome line, the dismiss button. The canvas behind it owns the field
 * and the emblem; this file owns the words.
 *
 * Everything below the emblem lives in ONE absolutely-positioned flow column
 * rather than being placed line by line, so a perk that wraps to two lines
 * pushes the welcome line down instead of landing on top of it.
 *
 * Colour rule, and the reason this file has no `text-white/70` anywhere: on a
 * saturated field an opacity-derived grey's contrast silently depends on the
 * ground behind it. Every non-white value here is a measured token from
 * `tier-theme.ts` used at FULL opacity.
 *
 * `skipped` means rest was reached by a skip rather than by playing through —
 * every staggered entrance REMOUNTS under a `skipped`-keyed `key` and renders
 * `initial={false}`, in final position with no entrance. Without the remount,
 * motion entrances already scheduled with stagger delays keep trailing in.
 *
 * Everything is `pointer-events-none` except the button: the stage root owns
 * clicks (skip / dismiss).
 */

const PERK_SPRING = { type: "spring", stiffness: 320, damping: 26, mass: 0.6 } as const;

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
  const played = skipped ? "skipped" : "played";
  const tracking = layout.narrow ? "0.16em" : "0.22em";

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* The kicker takes the caps line's exact metrics and its exact seat.
          It is consumed by the collapsing press and the same slot refills
          with the tier name — one caps line substituting for another in
          place, which turns two unrelated lines into a designed reveal. */}
      <AnimatePresence>
        {phase === "accrete" && !collapsed && (
          <motion.p
            key="kicker"
            className="absolute inset-x-0 flex justify-center"
            style={{ top: layout.lockupTop }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.4, duration: 0.6 } }}
            exit={{
              opacity: 0,
              y: layout.cy - layout.lockupTop,
              scale: 0.72,
              transition: { duration: 0.25, ease: EASE_HOUSE },
            }}
          >
            <span
              className="whitespace-nowrap font-[family-name:var(--font-sans)] font-semibold uppercase"
              style={{
                fontSize: layout.capsPx,
                lineHeight: 1,
                letterSpacing: tracking,
                marginRight: `-${tracking}`,
                color: theme.ink,
              }}
            >
              {theme.kicker}
            </span>
          </motion.p>
        )}
      </AnimatePresence>

      {/* The column: lockup, manifest, welcome. */}
      {slammed && (
        <div
          className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center"
          style={{ top: layout.lockupTop, width: layout.columnWidth }}
        >
          <CelebrationLockup
            name={theme.name}
            capsPx={layout.capsPx}
            wordPx={layout.wordPx}
            gapCaps={layout.gapCaps}
            tracking={tracking}
            ink={theme.ink}
            outline={theme.ink}
            skipped={skipped}
          />

          {/* The manifest. Each perk is a struck chip cut from the field's own
              light: the slab wipes in from the left, the diamond lands, the
              words are ink from frame one. Deliberately not glowing dots and
              hairlines — those are light-on-dark devices and are invisible
              here. */}
          {cascading && (
            <ul
              className={
                layout.narrow
                  ? "flex w-full flex-col"
                  : "grid w-full grid-cols-2 justify-items-start"
              }
              style={{
                marginTop: layout.gapPerks,
                gap: layout.perkGapY,
                columnGap: layout.narrow ? undefined : 24,
              }}
            >
              {theme.perks.map((perk, i) => {
                const delay = skipped ? 0 : (i * PERK_STAGGER_MS) / 1000;
                const from = layout.narrow ? -14 : i % 2 === 0 ? -18 : 18;
                return (
                  <motion.li
                    key={`${played}-${perk}`}
                    className={`relative isolate flex items-center gap-2.5 rounded-[3px] ${
                      layout.narrow ? "w-full px-3" : "w-fit px-3.5"
                    }`}
                    style={{ paddingBlock: layout.perkPadY, color: theme.ink }}
                    initial={skipped ? false : { opacity: 0, x: from, y: 6 }}
                    animate={{ opacity: 1, x: 0, y: 0 }}
                    transition={{ ...PERK_SPRING, delay }}
                  >
                    {/* The old hairline's beat, made solid. */}
                    <motion.span
                      aria-hidden
                      className="absolute inset-0 -z-10 origin-left rounded-[3px]"
                      style={{ backgroundColor: theme.chip }}
                      initial={skipped ? false : { scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={{
                        duration: 0.45,
                        ease: EASE_HOUSE,
                        delay: delay + 0.06,
                      }}
                    />
                    <motion.span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-[1px]"
                      style={{ backgroundColor: theme.ink }}
                      initial={skipped ? false : { rotate: 0, scale: 0 }}
                      animate={{ rotate: 45, scale: 1 }}
                      transition={{ ...PERK_SPRING, delay }}
                    />
                    <span style={{ fontSize: layout.perkPx, lineHeight: 1.375 }}>
                      {perk}
                    </span>
                  </motion.li>
                );
              })}
            </ul>
          )}

          {finale && !layout.cramped && (
            <motion.p
              key={`welcome-${played}`}
              className="text-balance text-center"
              style={{
                marginTop: layout.gapWelcome,
                fontSize: layout.welcomePx,
                lineHeight: 1.5,
                letterSpacing: "0.005em",
                color: theme.inkSoft,
              }}
              initial={skipped ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE_HOUSE, delay: skipped ? 0 : 0.4 }}
            >
              {theme.welcome}
            </motion.p>
          )}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-[max(2.5rem,env(safe-area-inset-bottom))] flex justify-center">
        {phase === "rest" ? (
          <motion.button
            key={`dismiss-${played}`}
            type="button"
            onClick={onDismiss}
            initial={skipped ? false : { opacity: 0, y: 16, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ ...PERK_SPRING, opacity: { duration: 0.12 } }}
            // A dark slab with a hard offset, not a bright pill with a glow:
            // on a bright field a light chip vanishes, and a blurred shadow
            // is the wrong register. The offset also buys a real press.
            className="pointer-events-auto rounded-[8px] font-semibold uppercase outline-none transition-[transform,box-shadow] duration-100 focus-visible:ring-2 focus-visible:ring-offset-2 active:translate-y-[3px]"
            style={{
              paddingInline: layout.narrow ? 32 : 36,
              paddingBlock: layout.narrow ? 12 : 14,
              fontSize: layout.narrow ? 15 : 16,
              lineHeight: "24px",
              letterSpacing: "0.14em",
              backgroundColor: theme.onField,
              color: theme.onFieldInk,
              boxShadow: `0 4px 0 0 ${theme.emblem.contour}`,
              ["--tw-ring-color" as string]: theme.ink,
              ["--tw-ring-offset-color" as string]: theme.field.mid,
            }}
          >
            Let&apos;s go
          </motion.button>
        ) : (
          (phase === "cascade" || phase === "finale") && (
            <motion.p
              className="uppercase"
              style={{
                fontSize: 11,
                letterSpacing: "0.18em",
                color: theme.inkFaint,
              }}
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
