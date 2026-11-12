"use client";

import { useEffect, useId, useRef, type RefObject } from "react";
import type { VoiceAgentControls, VoiceMode } from "@/lib/voice/contracts";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { smoothVoiceLevel } from "@/lib/voice/visual-level";

/** The two speakers have separate geometry and separate audio signals. No React audio ticks. */
export function VoiceOrbit({ controls, mode, muted }: {
  controls: RefObject<VoiceAgentControls | null>; mode: VoiceMode; muted: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);
  const reduced = usePrefersReducedMotion();
  const id = useId().replaceAll(":", "");
  useEffect(() => {
    let frame = 0;
    let input = 0;
    let output = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const levels = controls.current?.getLevels() ?? { input: 0, output: 0 };
      input = smoothVoiceLevel(input, muted ? 0 : levels.input, dt);
      output = smoothVoiceLevel(output, mode === "speaking" ? levels.output : 0, dt);
      const el = root.current;
      if (el) {
        el.style.setProperty("--voice-input", String(input));
        el.style.setProperty("--voice-output", String(output));
        el.style.setProperty("--voice-user-scale", String(reduced ? 1 : 1 + input * .13));
        el.style.setProperty("--voice-planet-scale", String(reduced ? 1 : 1 + output * .09));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [controls, mode, muted, reduced]);
  return (
    <svg ref={root} viewBox="0 0 400 320" className="voice-orbit w-full max-w-[420px]" data-mode={mode} data-muted={muted || undefined} aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-planet`} cx="32%" cy="27%" r="80%">
          <stop offset="0" stopColor="var(--voice-highlight)" />
          <stop offset=".55" stopColor="var(--voice-planet)" />
          <stop offset="1" stopColor="var(--voice-shadow)" />
        </radialGradient>
      </defs>
      <g className="voice-orbit-user">
        <ellipse cx="200" cy="160" rx="160" ry="74" transform="rotate(-25 200 160)" fill="none" stroke="var(--gold)" strokeWidth="1.8" />
        <ellipse className="voice-orbit-echo" cx="200" cy="160" rx="176" ry="88" transform="rotate(-25 200 160)" fill="none" stroke="var(--gold)" strokeWidth="1" />
      </g>
      <g className="voice-orbit-planet">
        <circle cx="200" cy="160" r="72" fill={`url(#${id}-planet)`} />
        <path d="M145 132 Q193 108 247 139" fill="none" stroke="var(--voice-highlight)" strokeOpacity=".4" strokeWidth="3" strokeLinecap="round" />
      </g>
      <ellipse className="voice-orbit-inner" cx="200" cy="160" rx="113" ry="101" transform="rotate(24 200 160)" fill="none" stroke="var(--voice-planet)" strokeWidth="1.2" />
      <g className="voice-orbit-moon">
        <circle cx="200" cy="59" r="6" fill="var(--gold)" />
      </g>
    </svg>
  );
}
