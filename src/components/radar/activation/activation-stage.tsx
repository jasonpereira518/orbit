"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { drawScene, fitCanvas, FIELD, preloadImages } from "@/components/radar/activation/activation-canvas";
import { BEAT, ringLayout, type SceneNode } from "@/lib/radar/activation-scene";
import { useModalTakeover } from "@/lib/use-modal-takeover";

/** The fade that lifts the navy at the end of the landing. */
const LIFT_MS = 300;

function statusFor(t: number): string {
  if (t < BEAT.ignite) return "Charging Radar…";
  if (t < BEAT.sweep) return "Lighting up your network";
  if (t < BEAT.land) return "Radar is watching";
  return "";
}

/** The nav's Radar icon, if one is on screen, as an offset from the viewport centre. */
function landingTarget(w: number, h: number): { dx: number; dy: number } | null {
  for (const el of document.querySelectorAll<HTMLElement>('a[href="/radar"]')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { dx: r.left + r.width / 2 - w / 2, dy: r.top + r.height / 2 - h / 2 };
  }
  return null;
}

/**
 * "Turn on Radar", full screen: one canvas, one rAF loop, every frame drawn from elapsed
 * time (`src/lib/radar/activation-scene.ts`). Skip (button, Escape, click, a hidden tab)
 * jumps time to the landing rather than aborting, so it always ends on the same picture.
 * Same contract as the credits intro: one layer below warp, modal for keyboard and readers.
 */
export function ActivationStage({
  nodes,
  hero,
  onDone,
}: {
  nodes: readonly SceneNode[];
  /** The in-page hero's box, so beat 1 grows out of it. */
  hero: DOMRect | null;
  onDone: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const skipRef = useRef<HTMLButtonElement | null>(null);
  const t0 = useRef(0);
  const doneRef = useRef(onDone);
  const [status, setStatus] = useState(statusFor(0));
  const [landed, setLanded] = useState(false);
  const [lifting, setLifting] = useState(false);
  useModalTakeover(rootRef);

  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    preloadImages(nodes, () => undefined);
    let w = window.innerWidth;
    let h = window.innerHeight;
    fitCanvas(canvas, ctx, w, h);
    const onResize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      fitCanvas(canvas, ctx, w, h);
    };
    window.addEventListener("resize", onResize);

    // Beat 1 starts where the hero sat, scaled to match its ring size.
    const from =
      hero
        ? {
            cx: hero.left + hero.width / 2,
            cy: hero.top + hero.height / 2,
            scale: ringLayout(hero.width, hero.height).radii[2] / ringLayout(w, h).radii[2],
          }
        : null;
    const to = landingTarget(w, h);
    const length = BEAT.end;
    t0.current = performance.now();
    let raf = 0;
    let lastStatus = "";
    let finished = false;
    const frame = (now: number) => {
      const elapsed = Math.min(now - t0.current, length);
      const t = elapsed;
      drawScene(ctx, { t, w, h, nodes, from, to });
      const s = statusFor(t);
      if (s !== lastStatus) {
        lastStatus = s;
        setStatus(s);
      }
      if (t >= BEAT.land) setLanded(true);
      if (elapsed >= length - LIFT_MS) setLifting(true);
      if (elapsed >= length) {
        if (!finished) {
          finished = true;
          doneRef.current();
        }
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // A hidden tab starves rAF: finish rather than strand an invisible overlay.
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && !finished) {
        finished = true;
        doneRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    skipRef.current?.focus();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // One play per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Skip = jump time to the landing.
  const skip = () => {
    const elapsed = performance.now() - t0.current;
    if (elapsed < BEAT.land) t0.current = performance.now() - BEAT.land;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Portalled to <body>: the page's reveal animation transforms an ancestor, which would
  // otherwise trap `position: fixed` inside the Radar card.
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Turning on Radar"
      tabIndex={-1}
      onClick={skip}
      className="fixed inset-0 z-[9998] touch-none overscroll-none outline-none"
      style={{ backgroundColor: FIELD, opacity: lifting ? 0 : 1, transition: `opacity ${LIFT_MS}ms ease-out` }}
    >
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
      <p
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-[12%] text-center font-heading text-lg text-[#F7F3E8]/85 transition-opacity duration-300"
        style={{ opacity: status ? 1 : 0 }}
      >
        {status}
      </p>
      <p className="sr-only" aria-live="polite">
        {landed ? "Radar is on. Building your first plan." : ""}
      </p>
      <button
        ref={skipRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          skip();
        }}
        className="absolute right-5 bottom-5 rounded-full px-4 py-2 text-sm text-[#F7F3E8]/70 hover:text-[#F7F3E8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c4a35a]"
      >
        Skip
      </button>
    </div>,
    document.body
  );
}
