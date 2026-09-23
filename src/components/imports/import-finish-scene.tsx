"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import {
  dotCount,
  FACE_RADIUS,
  layoutDots,
  settle,
  SCENE_HEIGHT,
  MAX_FACES,
  type Dot,
} from "@/lib/imports/finish-scene-geometry";

/**
 * `--primary` is a plain hex string in every theme (`globals.css`), so it goes straight into
 * `fillStyle` — same move as `liftoff-stage.tsx`'s `--background` read, fallback included in
 * case a future edit turns it into something a canvas can't parse.
 *
 * There is no equivalent token for the ring's gold. `--accent` is a pale background tint in
 * this system, not a warm accent, and the app's one dedicated gold (`--tier-lifetime`) is
 * reserved for the Orbit Lifetime badge on purpose — reusing it here is exactly the
 * two-meanings mistake its own comment warns against. The nearest real precedent is
 * `chat-orbit.tsx`'s planet, which rings itself in a flat `amber-300` regardless of theme;
 * this is that same literal (Tailwind's `--color-amber-300`, resolved to sRGB) rather than a
 * CSS variable, because `amber-300` is defined as `oklch(...)` and a canvas fillStyle should
 * not depend on a browser's oklch support for something this decorative.
 */
const TEAL_FALLBACK = "#0f3d3e";
const GOLD = "#fcd34d";

/**
 * The people an import brought in, arriving.
 *
 * A canvas rather than elements: an import can be thousands of people, and thousands of DOM
 * nodes with their own transforms is a different kind of page. The geometry lives next door in
 * a pure module so the maths is testable without a browser; this file owns pixels and lifetime.
 *
 * It stops when nobody is looking — off-screen or a hidden tab — because a drifting loop in a
 * background tab is a battery bug, and it never starts at all under reduced motion: that case
 * paints the settled frame once. The preference is read with `matchMedia` at effect time rather
 * than through a hook that reports the wrong value on its first render.
 *
 * Height comes from `SCENE_HEIGHT` itself, not a restated literal. Both values reach CSS as
 * custom properties on the canvas and a breakpoint class picks between them, so the very first
 * paint — before any effect has run — is already the right height at every width. (It used to
 * be an inline desktop height corrected by the effect, so a phone painted 180px and then
 * jumped.) The effect never decides the height: it reads the box CSS laid out, so the drawing
 * and the box cannot disagree, whatever the breakpoint resolves to. A `ResizeObserver` on the
 * canvas covers every change to that box — a width change, and the height flip at the
 * breakpoint alike.
 */
export function ImportFinishScene({
  people,
  faces,
}: {
  people: number;
  faces: { contactId: string; name: string; photo: string | null }[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let disposed = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const primaryRaw = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
    const teal = primaryRaw.startsWith("#") ? primaryRaw : TEAL_FALLBACK;

    // Faces don't depend on layout, so they can start loading before the canvas has a size.
    const count = dotCount(people);
    const images = new Map<number, HTMLImageElement>();
    for (let i = 0; i < Math.min(MAX_FACES, count); i++) {
      const photo = faces[i]?.photo;
      if (!photo) continue;
      // No `crossOrigin`: the canvas is only drawn to, never read back, so a tainted canvas
      // costs nothing — while asking for CORS made every avatar host that doesn't send the
      // header fail to load, and its face fell back to a dot.
      const img = new Image();
      img.onload = () => {
        if (disposed) return;
        images.set(i, img);
        // Under reduced motion nothing repaints on its own; a face that lands after the one
        // settled frame needs its own repaint or it never appears at all.
        if (reduced && width >= 2) paint(99, 0);
      };
      img.src = photo;
    }

    let width = 0;
    let height = 0;
    let dpr = 1;
    let dots: Dot[] = [];
    let cx = 0;
    let cy = 0;
    let started = false;
    let running = true;
    let raf = 0;
    let start = 0;

    function paint(elapsed: number, drift: number) {
      ctx!.clearRect(0, 0, width, height);

      // The planet, and its tilted ring.
      ctx!.beginPath();
      ctx!.fillStyle = teal;
      ctx!.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.save();
      ctx!.translate(cx, cy);
      ctx!.rotate(-0.31);
      ctx!.beginPath();
      ctx!.strokeStyle = GOLD;
      ctx!.globalAlpha = 0.7;
      ctx!.ellipse(0, 0, 26, 7, 0, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.restore();
      ctx!.globalAlpha = 1;

      dots.forEach((dot, i) => {
        const t = settle(Math.max(0, elapsed - dot.delay) / 1.4);
        if (t <= 0) return;
        const angle = dot.angle + drift * (dot.ring % 2 === 0 ? 1 : -1);
        // Arrive from outside: the radius eases in from 1.8x to its own.
        const rx = dot.radiusX * (1.8 - 0.8 * t);
        const ry = dot.radiusY * (1.8 - 0.8 * t);
        const x = cx + Math.cos(angle) * rx;
        const y = cy + Math.sin(angle) * ry;
        const img = images.get(i);
        ctx!.globalAlpha = Math.min(1, t);
        if (img) {
          ctx!.save();
          ctx!.beginPath();
          ctx!.arc(x, y, FACE_RADIUS, 0, Math.PI * 2);
          ctx!.clip();
          ctx!.drawImage(
            img,
            x - FACE_RADIUS,
            y - FACE_RADIUS,
            FACE_RADIUS * 2,
            FACE_RADIUS * 2,
          );
          ctx!.restore();
          ctx!.beginPath();
          ctx!.strokeStyle = GOLD;
          ctx!.lineWidth = 1;
          ctx!.arc(x, y, FACE_RADIUS, 0, Math.PI * 2);
          ctx!.stroke();
        } else {
          ctx!.beginPath();
          ctx!.fillStyle = dot.face ? GOLD : teal;
          ctx!.arc(x, y, dot.face ? 3.5 : 2, 0, Math.PI * 2);
          ctx!.fill();
        }
      });
      ctx!.globalAlpha = 1;
    }

    const loop = (now: number) => {
      if (!running) return;
      const elapsed = (now - start) / 1000;
      // Arrival for the first ~2s, then a slow drift so the card is alive but not busy.
      paint(elapsed, elapsed < 2 ? elapsed * 0.08 : 0.16 + (elapsed - 2) * 0.015);
      raf = requestAnimationFrame(loop);
    };

    // Starts the loop (or, under reduced motion, is a no-op — resize() paints directly) the
    // first time both a real size and permission to run land, whichever arrives second.
    function maybeStart() {
      if (started || !running || width < 2) return;
      started = true;
      start = performance.now();
      raf = requestAnimationFrame(loop);
    }

    function resize() {
      // Both dimensions are read off the box CSS laid out: the height is SCENE_HEIGHT's, chosen
      // by the breakpoint class below, and nothing here writes it back — so there is no style
      // write for the ResizeObserver to bounce on.
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      // A ResizeObserver can fire before layout has given the element a size.
      if (w < 2 || h < 2) return;
      width = w;
      height = h;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = layoutDots(people, width, height);
      cx = width / 2;
      cy = height / 2;

      if (reduced) {
        paint(99, 0);
        return;
      }
      if (started) {
        // Repaint immediately at the new geometry, or a live resize leaves a stretched frame
        // on screen until the next tick of the loop.
        paint(Math.max(0, (performance.now() - start) / 1000), 0);
      }
      maybeStart();
    }

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    if (reduced) {
      return () => {
        disposed = true;
        resizeObserver.disconnect();
      };
    }

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const resume = () => {
      if (running) return;
      running = true;
      if (started) {
        raf = requestAnimationFrame(loop);
      } else {
        maybeStart();
      }
    };
    const onVisibility = () => (document.hidden ? stop() : resume());
    document.addEventListener("visibilitychange", onVisibility);
    const intersectionObserver = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? resume() : stop()),
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    return () => {
      disposed = true;
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [people, faces]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // Tailwind's `sm` is the phone/desktop line, as everywhere else in the app. The class names
      // the variables; `SCENE_HEIGHT` fills them in below, so the numbers are written once.
      className="block w-full h-[var(--finish-scene-phone)] sm:h-[var(--finish-scene-desktop)]"
      style={SCENE_HEIGHT_VARS}
    />
  );
}

/** `SCENE_HEIGHT`, as the custom properties the canvas's height classes read. */
const SCENE_HEIGHT_VARS = {
  "--finish-scene-phone": `${SCENE_HEIGHT.phone}px`,
  "--finish-scene-desktop": `${SCENE_HEIGHT.desktop}px`,
} as CSSProperties;
