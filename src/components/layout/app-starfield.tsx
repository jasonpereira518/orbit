"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { STAR_GOLD, STAR_WHITE } from "@/lib/sky-palette";

/**
 * Whether the app is in dark mode, read straight off `html.dark` rather than
 * from next-themes.
 *
 * The class is what actually drives every dark token in CSS, so watching it
 * directly is both the most truthful source and the most responsive one — it
 * flips in the same frame the theme does. `getServerSnapshot` returns false so
 * the server renders nothing (this component portals to `document.body`, which
 * does not exist during SSR); React then swaps in the real value at hydration,
 * which is precisely what useSyncExternalStore exists to make safe.
 *
 * The prevailing pattern nearby is a `useEffect(() => setMounted(true))` gate.
 * That works, but it is a setState-in-effect, and it needs a second render
 * before it can know the theme. This needs neither.
 */
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const isDarkNow = () => document.documentElement.classList.contains("dark");
const isDarkOnServer = () => false;

type Star = {
  x: number;
  y: number;
  r: number;
  a: number;
  twinkle: number;
  phase: number;
  gold: boolean;
  bloom: boolean;
};

/** One star per this many px². The landing packs one per 2650px² of a field
 * two viewports tall — an effective ~489 per viewport at 1440x900. This is
 * half that. Raise it to thin the sky further. */
const STAR_AREA = 5300;
/** Bounds the per-frame arc count on ultrawide and 4K displays, where the
 * area-derived count would otherwise run into four figures. */
const STAR_CAP = 700;

/**
 * The app's ambient sky.
 *
 * Deliberately NOT the landing starfield (components/landing/starfield.tsx),
 * even though they share `lib/sky-palette.ts`. Three differences, each for a
 * reason:
 *
 *  1. Stars only, on a transparent canvas. The landing field calls
 *     `paintSpace()` to lay down the deep-space gradient and nebulae. Here
 *     that base already exists in CSS — `--background` plus the two nebula
 *     washes on `.dark body` — so painting it again would double the nebulae
 *     on top of themselves and add a full-screen radial fill per resize.
 *
 *  2. No parallax. `main` is the app's scroll container, not the window, so
 *     the landing's `window.scrollY` would read 0 forever. A viewport-sized
 *     static field is also the calmer read behind data you are trying to
 *     work with.
 *
 *  3. Thinner and dimmer, with no shooting stars. The landing sky is a
 *     showpiece you look AT; this one sits behind a contact list.
 *
 * Everything load-bearing IS carried over: the DPR cap, the viewport-sized
 * canvas, the hidden-tab pause and the reduced-motion path.
 */
export function AppStarfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  const active = useSyncExternalStore(
    subscribeToTheme,
    isDarkNow,
    isDarkOnServer,
  );

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let stars: Star[] = [];
    let width = 0;
    let height = 0;
    let dpr = 1;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(Math.floor((width * height) / STAR_AREA), STAR_CAP);
      stars = Array.from({ length: count }, () => {
        const gold = Math.random() < 0.04;
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          r: Math.random() * 1.2 + 0.3,
          // Dimmer than the landing's 0.25-0.80: this sky sits behind text.
          a: Math.random() * 0.37 + 0.18,
          // 0.6x the landing rate — a slow breath rather than a shimmer.
          twinkle: Math.random() * 0.0048 + 0.0024,
          phase: Math.random() * Math.PI * 2,
          gold,
          bloom: gold && Math.random() < 0.35,
        };
      });

      // With no rAF running, the one static frame has to be repainted here or
      // a resize would leave a stretched, stale field.
      if (reduced) draw(performance.now());
    }

    function draw(now: number) {
      ctx!.clearRect(0, 0, width, height);

      for (const s of stars) {
        const alpha = reduced
          ? s.a
          : s.a * (0.65 + 0.35 * Math.sin(now * s.twinkle + s.phase));

        if (s.bloom) {
          ctx!.shadowBlur = 6;
          ctx!.shadowColor = `rgba(${STAR_GOLD}, 0.8)`;
        }
        ctx!.beginPath();
        ctx!.fillStyle = s.gold
          ? `rgba(${STAR_GOLD}, ${alpha})`
          : `rgba(${STAR_WHITE}, ${alpha})`;
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
        if (s.bloom) ctx!.shadowBlur = 0;
      }

      if (!reduced) raf = requestAnimationFrame(draw);
    }

    // Don't burn battery twinkling in a background tab.
    function onVisibility() {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) raf = requestAnimationFrame(draw);
    }

    // Listeners attach before the first draw so a zero-sized viewport at mount
    // (prerender, or a hidden tab being restored) can still be repaired by the
    // resize event that gives it real dimensions.
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);

    resize();
    draw(performance.now());

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
    };
  }, [active, reduced]);

  if (!active) return null;

  // Portalled to <body> rather than rendered in place: AppShell's root carries
  // `data-warp-craft`, and lift-off transforms it. A transformed ancestor
  // becomes the containing block for `position: fixed`, so an in-place sky
  // would fly away with the dashboard instead of staying put behind it.
  // WarpStage portals out for exactly this reason.
  return createPortal(
    <canvas
      ref={canvasRef}
      aria-hidden
      // -z-10 sits above the body background propagated to the viewport canvas
      // (the navy plus its nebula washes) but below every app surface.
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />,
    document.body,
  );
}
