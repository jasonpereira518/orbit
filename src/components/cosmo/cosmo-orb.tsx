"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue } from "motion/react";
import { VoiceOrbit } from "@/components/chat/voice/voice-orbit";
import { useSelectorRect } from "@/lib/tour/use-anchor-rect";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { SPRING_SOFT } from "@/lib/motion";
import { useVoiceCall, voiceControls } from "@/lib/voice/call-store";
import "@/components/chat/voice/voice-overlay.css";

/** Where the orb may sit: Chat's big stage, or Cosmo's docked bar. The stage comes first in the DOM, so it wins. */
export const ORB_SLOT = "[data-cosmo-orb-slot]";

/**
 * Cosmo's ONE live orb. The stage and the docked bar only leave an empty slot; this fixed canvas
 * flies to whichever slot is on screen, so going in and out of Chat is one orb moving, not two
 * orbs swapping. It springs only between slots (FLIP: real size at once, scale from the old);
 * a scroll or resize within a slot just follows. Never takes clicks: they reach the slot button.
 */
export function CosmoOrb() {
  const { mode, muted } = useVoiceCall();
  const reduced = usePrefersReducedMotion();
  const { rect, el } = useSelectorRect(ORB_SLOT, "cosmo-orb");
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const box = rect && el ? { size: Math.min(rect.width, rect.height), kind: el.dataset.cosmoOrbSlot ?? "dock" } : null;
  const last = useRef<{ size: number; kind: string } | null>(null);
  const flying = useRef(0);

  // Before paint, so the first frame at a new canvas size is already scaled back to the old one.
  useLayoutEffect(() => {
    if (!rect || !el) return;
    const kind = el.dataset.cosmoOrbSlot ?? "dock";
    const size = Math.min(rect.width, rect.height);
    const tx = rect.left + (rect.width - size) / 2;
    const ty = rect.top + (rect.height - size) / 2;
    const prev = last.current;
    last.current = { size, kind };
    if (!prev || reduced || (prev.kind === kind && !flying.current)) {
      x.set(tx);
      y.set(ty);
      scale.set(1);
      return;
    }
    // Same visual size as a moment ago, at the new canvas size; then glide and grow (or shrink).
    if (prev.kind !== kind) scale.set((prev.size * scale.get()) / size);
    const flight = ++flying.current;
    void Promise.all([animate(x, tx, SPRING_SOFT), animate(y, ty, SPRING_SOFT), animate(scale, 1, SPRING_SOFT)]).then(() => {
      if (flying.current === flight) flying.current = 0;
    });
  }, [rect, el, reduced, x, y, scale]);

  // Docked, the bar itself moves (drag, a glide to another slot), which no event reports: follow
  // its slot every frame, unless the orb is mid-flight between stage and dock.
  const dockEl = box?.kind === "dock" ? el : null;
  useEffect(() => {
    if (!dockEl) return;
    let frame = 0;
    const follow = () => {
      if (!flying.current) {
        const r = dockEl.getBoundingClientRect();
        const size = Math.min(r.width, r.height);
        x.set(r.left + (r.width - size) / 2);
        y.set(r.top + (r.height - size) / 2);
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [dockEl, x, y]);

  // Its slot is the button under it (clicking ends the call): light up while that is hovered.
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!el) return;
    const on = () => setHover(true);
    const off = () => setHover(false);
    el.addEventListener("pointerenter", on);
    el.addEventListener("pointerleave", off);
    return () => {
      el.removeEventListener("pointerenter", on);
      el.removeEventListener("pointerleave", off);
      setHover(false);
    };
  }, [el]);

  if (!box) return null;
  return (
    <motion.div
      aria-hidden
      data-orb-place={box.kind}
      data-hover={hover || undefined}
      // In Chat's stage: over the page's cards, under menus and dialogs (z-50). Docked: just above
      // its bar, which sits over dialogs (z-51) so Cosmo stays usable with one open.
      className={box.kind === "stage" ? "cosmo-orb pointer-events-none fixed top-0 left-0 z-40" : "cosmo-orb pointer-events-none fixed top-0 left-0 z-[52]"}
      style={{ x, y, scale, width: box.size, height: box.size, transformOrigin: "0 0" }}
    >
      <VoiceOrbit controls={voiceControls} mode={mode} muted={muted} />
    </motion.div>
  );
}
