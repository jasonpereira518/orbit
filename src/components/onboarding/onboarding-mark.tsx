import { useId } from "react";
import { cn } from "@/lib/utils";

/** The ring's squash: ry / rx of the ellipse the moon rides. */
const RING_RX = 44;
const RING_RY = 15;
const SQUASH = RING_RY / RING_RX;

/** Rotation about the local origin. SVG's own defaults, spelled out so no global rule moves them. */
const SPIN = "[transform-box:view-box] origin-[0_0]";

/**
 * Onboarding's motif: a teal planet with a tilted gold ring, and a small gold moon riding the
 * ring (one lap in 5s). The planet never moves. Not the app logo (`OrbitLogo`), which stays
 * everywhere outside onboarding; `OrbitMark` is chat's.
 *
 * The moon's ellipse is a CSS rotation, not SMIL: an inner group spins inside an outer group
 * that is squashed to the ring's shape and tilted with it, and the moon counter-spins and
 * un-squashes itself so it stays round. Being a CSS animation, the repo's one global
 * `prefers-reduced-motion` clamp stops it (the moon rests at the ring's right end).
 *
 * The back half of the ring is drawn before the planet and the front half after, so the
 * planet sits inside the ring. Decorative: always next to the word "Orbit" or a heading.
 */
export function OnboardingMark({ size = 20, className }: { size?: number; className?: string }) {
  const gradient = `${useId()}-planet`;
  return (
    <svg
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      aria-hidden
      focusable="false"
      className={cn("shrink-0 overflow-visible", className)}
    >
      <defs>
        <radialGradient id={gradient} cx="35%" cy="32%" r="70%">
          <stop offset="0" style={{ stopColor: "color-mix(in oklab, var(--primary) 72%, white)" }} />
          <stop offset="0.7" style={{ stopColor: "var(--primary)" }} />
          <stop offset="1" style={{ stopColor: "color-mix(in oklab, var(--primary) 78%, black)" }} />
        </radialGradient>
      </defs>
      <g transform="rotate(-22)">
        <path
          d={`M${RING_RX} 0A${RING_RX} ${RING_RY} 0 0 0 ${-RING_RX} 0`}
          fill="none"
          stroke="var(--gold)"
          strokeWidth={3.2}
          strokeDasharray="2 5"
          strokeLinecap="round"
          opacity={0.6}
        />
      </g>
      <circle r={22} fill={`url(#${gradient})`} />
      <path d="M-17 -6c10-4 24-4 34 2" stroke="#fff" strokeOpacity={0.16} strokeWidth={3} fill="none" strokeLinecap="round" />
      <g transform="rotate(-22)">
        <path
          d={`M${-RING_RX} 0A${RING_RX} ${RING_RY} 0 0 0 ${RING_RX} 0`}
          fill="none"
          stroke="var(--gold)"
          strokeWidth={3.2}
          strokeLinecap="round"
        />
        <g transform={`scale(1 ${SQUASH})`}>
          <g className={cn(SPIN, "animate-[spin_5s_linear_infinite]")}>
            <g transform={`translate(${RING_RX} 0)`}>
              <g className={cn(SPIN, "animate-[spin_5s_linear_infinite_reverse]")}>
                <circle r={6} transform={`scale(1 ${1 / SQUASH})`} fill="var(--gold)" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
