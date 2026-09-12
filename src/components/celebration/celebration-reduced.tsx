"use client";

import type { TierTheme } from "@/lib/celebration/tier-theme";
import { CelebrationLockup } from "@/components/celebration/celebration-lockup";

/**
 * The reduced-motion celebration: same news, delivered calmly.
 *
 * House rule (starfield's single static frame, warp's plain cross-fade): a
 * different, still-present composition — never a degraded animation. One
 * 200ms opacity fade on the stage root is the only motion; no canvas, no
 * strike, no cascade. The viewer gets the full announcement immediately and
 * leaves when they choose.
 *
 * It sits on the same bright field as the animated path and uses the same
 * lockup component — the two used to drift (this file set the name in
 * Fraunces while the stage used Outfit, announcing one event in two
 * typefaces). No card, no border: flat means the composition sits directly on
 * the field. This is also the ONE place scrolling is correct, because nothing
 * here is choreographed and there is no vertical budget to honour.
 */
export function CelebrationReduced({
  theme,
  onDismiss,
}: {
  theme: TierTheme;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-y-auto px-6 py-10"
      style={{
        background: `radial-gradient(120% 100% at 50% 32%, ${theme.field.hot} 0%, ${theme.field.mid} 42%, ${theme.field.edge} 100%)`,
      }}
    >
      <div className="w-full max-w-md text-center">
        <CelebrationLockup
          name={theme.name}
          capsPx="clamp(12px, 3.2vw, 15px)"
          wordPx="clamp(40px, 11vw, 76px)"
          gapCaps="0.065em"
          tracking="0.2em"
          ink={theme.ink}
          outline={theme.ink}
          animate={false}
        />

        <p className="mt-4 text-sm" style={{ color: theme.inkSoft }}>
          {theme.welcome}
        </p>

        <ul className="mt-6 flex flex-col gap-1.5 text-left">
          {theme.perks.map((perk) => (
            <li
              key={perk}
              className="flex items-center gap-2.5 rounded-[3px] px-3 py-1.5"
              style={{ backgroundColor: theme.chip, color: theme.ink }}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rotate-45 rounded-[1px]"
                style={{ backgroundColor: theme.ink }}
              />
              <span className="text-sm">{perk}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-8 w-full rounded-[8px] py-3 font-semibold uppercase outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{
            letterSpacing: "0.14em",
            backgroundColor: theme.onField,
            color: theme.onFieldInk,
            boxShadow: `0 4px 0 0 ${theme.emblem.contour}`,
            ["--tw-ring-color" as string]: theme.ink,
            ["--tw-ring-offset-color" as string]: theme.field.mid,
          }}
        >
          Let&apos;s go
        </button>
      </div>
    </div>
  );
}
