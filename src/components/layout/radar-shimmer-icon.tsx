"use client";

import { useId } from "react";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { useAppPulse } from "@/lib/app-pulse-store";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Whether Radar has suggestions created since /radar was last opened (the app pulse's
 * `radarNew`). Never true on /radar itself, where you are already looking at them.
 */
export function useRadarHasNew(): boolean {
  const { pulse } = useAppPulse();
  const pathname = usePathname();
  return Boolean(pulse && pulse.radarNew > 0 && !pathname.startsWith("/radar"));
}

/**
 * A nav icon that, while Radar has new suggestions, turns green with a glint of light sweeping
 * across its lines (Jason, Nov 11: a shimmer on the icon, no pulse around it). `radar` says
 * whether this icon speaks for Radar: the Radar link itself, or More while Radar sits behind it.
 *
 * The glint is an SVG gradient on the icon's own stroke, in the 24×24 icon space, so it
 * crosses the whole radar as one sweep. Reduced motion keeps it green and still.
 */
export function RadarShimmerIcon({ icon: Icon, radar, className }: { icon: LucideIcon; radar: boolean; className?: string }) {
  const hasNew = useRadarHasNew();
  const reduced = usePrefersReducedMotion();
  const id = `radar-shimmer-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  if (!radar || !hasNew) return <Icon className={className} aria-hidden />;
  return (
    <>
      <svg width="0" height="0" aria-hidden className="absolute">
        <defs>
          <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
            <stop offset="0" className="radar-shimmer-base" />
            <stop offset="0.32" className="radar-shimmer-base" />
            <stop offset="0.5" className="radar-shimmer-glint" />
            <stop offset="0.68" className="radar-shimmer-base" />
            <stop offset="1" className="radar-shimmer-base" />
            {!reduced && (
              // A sweep, then a short rest: the glint crosses in 1.6s, the icon holds green 0.6s.
              <animateTransform
                attributeName="gradientTransform"
                type="translate"
                values="-24 -24; 24 24; 24 24"
                keyTimes="0; 0.73; 1"
                dur="2.2s"
                repeatCount="indefinite"
              />
            )}
          </linearGradient>
        </defs>
      </svg>
      <Icon className={className} stroke={`url(#${id})`} aria-hidden />
    </>
  );
}

/** Put after the link's label, so a screen reader hears "Radar, new suggestions". */
export function RadarNewText() {
  return useRadarHasNew() ? <span className="sr-only">, new suggestions</span> : null;
}
