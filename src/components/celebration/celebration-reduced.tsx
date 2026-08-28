"use client";

import type { TierTheme } from "@/lib/celebration/tier-theme";
import { OrbitLogo } from "@/components/orbit-logo";

/**
 * The reduced-motion celebration: same news, delivered calmly.
 *
 * House rule (starfield's single static frame, warp's plain cross-fade): a
 * different, still-present composition — never a degraded animation. One
 * 200ms opacity fade on the stage root is the only motion; no canvas, no
 * shake, no cascade. The viewer gets the full announcement immediately —
 * mark, name, spoils — and leaves when they choose.
 */
export function CelebrationReduced({
  theme,
  onDismiss,
}: {
  theme: TierTheme;
  onDismiss: () => void;
}) {
  const space = theme.space
    .map((s) => `${s.color} ${Math.round(s.at * 100)}%`)
    .join(", ");

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-y-auto px-6"
      style={{ background: `radial-gradient(120% 100% at 50% 42%, ${space})` }}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-8 text-center"
        style={{
          borderColor: `rgba(${theme.glowRgb}, 0.3)`,
          backgroundColor: `rgba(${theme.deepRgb}, 0.55)`,
        }}
      >
        <div className="flex justify-center">
          <OrbitLogo size="xl" plan={theme.plan} />
        </div>
        <p className="mt-4 text-sm text-white/60">You now have</p>
        <h1
          className="mt-1 bg-clip-text font-[family-name:var(--font-display)] text-4xl font-semibold uppercase tracking-tight text-transparent"
          style={{
            backgroundImage: `linear-gradient(180deg, ${theme.metal.sheen} 0%, ${theme.metal.hi} 38%, ${theme.metal.lo} 100%)`,
          }}
        >
          {theme.name}
        </h1>
        <p className="mt-3 text-sm text-white/75">{theme.welcome}</p>
        <ul className="mt-6 space-y-2.5 text-left">
          {theme.perks.map((perk) => (
            <li key={perk} className="flex items-center gap-3">
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: theme.accent }}
              />
              <span className="text-sm text-white/85">{perk}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-8 w-full rounded-full px-6 py-3 text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          style={{
            color: theme.deep,
            backgroundImage: `linear-gradient(to bottom, ${theme.metal.hi}, ${theme.metal.lo})`,
          }}
        >
          Let&apos;s go
        </button>
      </div>
    </div>
  );
}
