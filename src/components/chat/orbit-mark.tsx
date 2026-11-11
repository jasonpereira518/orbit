"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

/** The orbit's ellipse and tilt, in the -50..50 viewBox. */
const RX = 40;
const RY = 13;
const SQUASH = RY / RX;
const TILT = -20;
const MOON_R = 8.5;
/** Where reduced motion parks the moon: front right, clear of the planet's face. */
const PARK_DEG = 35;

/**
 * Chat's "the model is working" mark: a planet with one moon on a tilted orbit.
 *
 * The moon dips behind the planet and swings back round in front. That takes two copies of the
 * same moon on the same lap: one drawn under the planet, and one over it, clipped to the orbit's
 * near half. The lap is CSS (`.orbit-mark-lap` in theme.css), using the onboarding mark's spin
 * inside a squashed group, with a counter-spin so the moon stays round.
 *
 * Reduced motion parks the moon instead of letting the global clamp stop it on a random frame
 * (the clamp would leave it at the back, behind the planet). That is decided at render time,
 * because `usePrefersReducedMotion` reports false on its first render.
 */
export function OrbitMark({
  reduceMotion,
  className,
  /**
   * "primary" (default) is a teal planet, for the muted text this sits beside. "current" draws
   * the planet in `currentColor`, for a spot on a primary fill like the ask bar's send button.
   */
  tone = "primary",
}: {
  reduceMotion: boolean;
  className?: string;
  tone?: "primary" | "current";
}) {
  const id = useId();
  const gradient = `${id}-planet`;
  const nearHalf = `${id}-near`;
  const planetFill = tone === "current" ? "currentColor" : `url(#${gradient})`;
  const orbitStroke = tone === "current" ? "currentColor" : "var(--gold)";

  const moon = (
    <g transform={`scale(1 ${SQUASH})`}>
      <g className="orbit-mark-lap">
        <g transform={`translate(${RX} 0)`}>
          <g className="orbit-mark-unlap">
            <circle r={MOON_R} transform={`scale(1 ${1 / SQUASH})`} fill="var(--gold)" />
          </g>
        </g>
      </g>
    </g>
  );
  const rad = (PARK_DEG * Math.PI) / 180;

  return (
    <svg
      viewBox="-50 -50 100 100"
      aria-hidden="true"
      focusable="false"
      className={cn("size-5 shrink-0 overflow-visible", className)}
    >
      <defs>
        <radialGradient id={gradient} cx="35%" cy="32%" r="70%">
          <stop offset="0" style={{ stopColor: "color-mix(in oklab, var(--primary) 70%, white)" }} />
          <stop offset="0.7" style={{ stopColor: "var(--primary)" }} />
          <stop offset="1" style={{ stopColor: "color-mix(in oklab, var(--primary) 78%, black)" }} />
        </radialGradient>
        <clipPath id={nearHalf} clipPathUnits="userSpaceOnUse">
          <rect x={-60} y={0} width={120} height={60} />
        </clipPath>
      </defs>

      {/* Far side: the back of the orbit, and a moon the planet hides. */}
      <g transform={`rotate(${TILT})`}>
        <path
          d={`M${RX} 0A${RX} ${RY} 0 0 0 ${-RX} 0`}
          fill="none"
          stroke={orbitStroke}
          strokeWidth={2.5}
          opacity={0.35}
        />
        {!reduceMotion && moon}
      </g>

      <circle r={21} fill={planetFill} />
      {tone === "primary" && (
        <path d="M-15 -7c9-4 21-4 30 2" stroke="#fff" strokeOpacity={0.2} strokeWidth={3} fill="none" strokeLinecap="round" />
      )}

      {/* Near side: the front of the orbit, and the moon passing in front of the planet. */}
      <g transform={`rotate(${TILT})`}>
        <path
          d={`M${-RX} 0A${RX} ${RY} 0 0 0 ${RX} 0`}
          fill="none"
          stroke={orbitStroke}
          strokeWidth={2.5}
          opacity={0.5}
        />
        {reduceMotion ? (
          <circle cx={RX * Math.cos(rad)} cy={RY * Math.sin(rad)} r={MOON_R} fill="var(--gold)" />
        ) : (
          <g clipPath={`url(#${nearHalf})`}>{moon}</g>
        )}
      </g>
    </svg>
  );
}
