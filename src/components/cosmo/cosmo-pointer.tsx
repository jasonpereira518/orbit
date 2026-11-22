"use client";
import { useEffect } from "react";
import { TourCursor } from "@/components/tour/tour-cursor";
import { useSelectorRect } from "@/lib/tour/use-anchor-rect";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { advancePointing, stopPointing, usePointing } from "@/lib/cosmo/pointer-store";
import "./cosmo.css";

/** How long a step waits for its control to show up (a page loading, a list arriving). */
const FIND_MS = 12_000;

/**
 * Cosmo's hand: the tour's gliding cursor, in Cosmo's colours, on the control `point_at` named,
 * with a soft ring around it. The person clicks; the walk moves on (a nav link first when the
 * control is on another page). Escape puts the cursor away. It only shows — it never clicks.
 */
export function CosmoPointer() {
  const pointing = usePointing();
  const step = pointing ? pointing.steps[pointing.index] : null;
  const key = pointing ? `${pointing.id}:${pointing.index}` : "none";
  const reduced = usePrefersReducedMotion();
  const { rect, el, status } = useSelectorRect(step?.selector ?? null, key);

  // Bring it into view once it's there.
  useEffect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [el, reduced]);

  // The person's click on it (capture phase, so a control that stops propagation still counts).
  useEffect(() => {
    if (!step) return;
    const onClick = (event: MouseEvent) => {
      if (event.isTrusted && (event.target as Element | null)?.closest?.(step.selector)) advancePointing();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stopPointing("The user put the pointer away.");
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [step]);

  // Never point at nothing for long.
  const found = status === "found";
  useEffect(() => {
    if (!step || found) return;
    const timer = window.setTimeout(() => stopPointing(`The ${step.label} isn't on screen, so the pointer stopped.`), FIND_MS);
    return () => window.clearTimeout(timer);
  }, [step, found]);

  if (!step) return null;
  const target = rect ? { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 } : null;
  const dock = typeof document === "undefined" ? null : document.querySelector("[data-cosmo-orb-slot]")?.getBoundingClientRect();
  const origin = dock ? { x: dock.left, y: dock.top } : { x: 24, y: 24 };
  return (
    <>
      {rect && (
        <div
          aria-hidden
          className="cosmo-ring pointer-events-none fixed z-[55]"
          style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}
      <TourCursor target={target} mode="point" stopKey={key} origin={origin} reduced={reduced} label="Cosmo" tone="aurora" />
      {/* One quiet line per step, never a running commentary. */}
      <p className="sr-only" aria-live="polite">
        Cosmo is pointing at the {step.label}.
      </p>
    </>
  );
}
