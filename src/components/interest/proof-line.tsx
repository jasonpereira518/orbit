"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { PlanetArt } from "@/components/interest/planet-art";
import { formatTicketNumber } from "@/lib/interest-list";
import type { InterestProof } from "@/lib/interest-list-ticket";
import { cn } from "@/lib/utils";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { planetForSignupNumber, planetLabel, type WelcomePlanet } from "@/lib/welcome-planets";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * "1,284 people on the waitlist", or "Next up:" and the next three planets to be handed out, below the count floor.
 *
 * The server renders the final number; after hydration the digits roll up from a few
 * dozen below, once. The roll starts in an effect, never in render, so the HTML and the
 * first client render agree.
 */
export function ProofLine({ proof, showCount }: { proof: InterestProof; showCount: boolean }) {
  const stack = (list: WelcomePlanet[]) => <PlanetStack list={list} />;
  // Planets go out by join ordinal, so the next three signups' planets are known now.
  const upcoming = [1, 2, 3].map((n) => planetForSignupNumber(proof.total + n));
  return (
    <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm leading-[1.6] text-[#9aada8]">
      {showCount ? (
        <>
          {stack(proof.recent)}
          <span>
            <RollingCount value={proof.count} /> people on the waitlist
          </span>
        </>
      ) : (
        <>
          <span>Next up: {planetLabel(upcoming[0])}</span>
          {stack(upcoming)}
        </>
      )}
    </p>
  );
}

/** Rolls from `value − 40` to `value` after mount; instant under reduced motion. */
export function RollingCount({ value, delay = 0 }: { value: number; delay?: number }) {
  const reduced = usePrefersReducedMotion();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => formatTicketNumber(Math.round(v)));
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (reduced) {
      mv.set(value);
      return;
    }
    mv.set(Math.max(1, value - 40));
    const controls = animate(mv, value, { duration: DUR.celestial, ease: EASE_HOUSE, delay });
    return () => controls.stop();
  }, [value, reduced, mv, delay]);

  // Before mount, the static number — identical to the server HTML.
  if (!mounted) return <span className="tabular-nums">{formatTicketNumber(value)}</span>;
  return <motion.span className="tabular-nums">{text}</motion.span>;
}

/**
 * Transitions.dev's avatar-group hover, on the planet stack. Entering one planet lifts and
 * scales it and lifts its neighbours by a falling-off amount, so the row reads as one
 * flexible thing rather than three separate hit targets. The values live on the items as
 * `--shift` / `--scale-active`, read by `.t-avatar` in globals.css, which also switches
 * the whole effect off under reduced motion.
 *
 * Written straight to the DOM rather than through state: it fires on every mouseenter and
 * there is nothing to render, so a re-render would only add a frame of latency.
 */
function PlanetStack({ list }: { list: WelcomePlanet[] }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const activeRef = useRef<number | null>(null);

  const apply = (active: number | null) => {
    if (activeRef.current === active) return;
    activeRef.current = active;
    const root = rootRef.current;
    if (!root) return;
    const css = getComputedStyle(root);
    const lift = Number.parseFloat(css.getPropertyValue("--avatar-lift")) || -4;
    const scale = Number.parseFloat(css.getPropertyValue("--avatar-scale")) || 1.05;
    const falloff = Number.parseFloat(css.getPropertyValue("--avatar-falloff")) || 0.45;
    // The curve is set BEFORE the values it should govern: both are non-overshooting
    // ease-outs, so release settles without dipping below rest.
    const ease = active === null ? "var(--avatar-ease-out)" : "var(--avatar-ease-in)";
    root.querySelectorAll<HTMLElement>(".t-avatar").forEach((el, i) => {
      el.style.transitionTimingFunction = ease;
      if (active === null) {
        el.style.setProperty("--shift", "0px");
        el.style.setProperty("--scale-active", "1");
        return;
      }
      el.style.setProperty("--shift", `${(lift * Math.pow(falloff, Math.abs(i - active))).toFixed(3)}px`);
      el.style.setProperty("--scale-active", String(i === active ? scale : 1));
    });
  };

  // Exactly one planet is "under" the pointer: the nearest centre. The planets overlap by
  // 4px, so per-item mouseenter left the seam ambiguous, and because each item moves when
  // it lifts, the hit target moved out from under the cursor and re-fired the neighbour.
  // The hit targets here are the static outer spans, which never transform.
  const track = (clientX: number) => {
    const slots = rootRef.current?.children;
    if (!slots) return;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].getBoundingClientRect();
      const d = Math.abs(clientX - (r.left + r.width / 2));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    apply(best);
  };

  return (
    <span
      ref={rootRef}
      className="flex items-center"
      aria-hidden="true"
      onMouseMove={(e) => track(e.clientX)}
      onMouseLeave={() => apply(null)}
    >
      {list.map((planet, i) => (
        <span key={`${planet}-${i}`} className={cn("inline-flex", i > 0 && "-ml-1")}>
          <span className="t-avatar inline-flex">
            <PlanetArt planet={planet} size={20} />
          </span>
        </span>
      ))}
    </span>
  );
}
