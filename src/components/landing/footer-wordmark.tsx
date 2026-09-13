"use client";

import { useEffect, useRef } from "react";
import {
  BASELINE,
  DOT_SHARE,
  FLARE_MS,
  FONT_SIZE,
  INK_LEFT,
  INK_WIDTH,
  TRAIL_RADIUS,
  VIEW_H,
  WEIGHT,
  baseColor,
  buildGrid,
  dotsNearSegment,
  pitchFor,
  twinkle,
  type Dot,
} from "@/components/landing/footer-wordmark-field";
import { cn } from "@/lib/utils";

const FLARE_RGB = "255, 244, 200";
const HALO_RGB = "255, 233, 160";

/** Samples the letters once per layout: true where a point falls inside "Orbit". */
function glyphMask(width: number, height: number, family: string) {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const g = scratch.getContext("2d", { willReadFrequently: true });
  if (!g) return () => false;
  const s = width / INK_WIDTH;
  g.font = `${WEIGHT} ${FONT_SIZE * s}px ${family}`;
  g.fillText("Orbit", -INK_LEFT * s, BASELINE * s);
  const alpha = g.getImageData(0, 0, w, h).data;
  return (x: number, y: number) => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= w || py >= h) return false;
    return alpha[(py * w + px) * 4 + 3] > 127;
  };
}

/**
 * The landing page's last frame: "Orbit" written in a fine grid of star dots, fading in
 * from the dark and cut off by the bottom of the page. A pointer drawn across it leaves a
 * twinkling trail; a tap on a phone flares a small burst.
 *
 * The wrapper reserves the exact height in the server HTML, so the canvas filling it on
 * hydration shifts nothing. The animation loop only runs while a flare is still fading.
 * Reduced motion gets the resting field and no trail.
 *
 * Not wrapped in <Reveal>: that observer ignores the bottom tenth of the viewport, and on
 * a phone this whole element fits inside it, so it would wait hidden forever. Its bottom
 * edge is the page's bottom edge, so nothing may follow it.
 */
export function FooterWordmark({ className }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !ctx) return;

    const base = document.createElement("canvas");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const family = getComputedStyle(canvas).fontFamily;
    const active = new Set<number>();
    let dots: Dot[] = [];
    let radius = 1;
    let dpr = 1;
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    let disposed = false;

    function paintBase() {
      const b = base.getContext("2d");
      if (!b) return;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, base.width, base.height);
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      // One fill per row: every dot in a row shares its colour.
      let row = Number.NaN;
      for (const d of dots) {
        if (d.y !== row) {
          if (!Number.isNaN(row)) b.fill();
          row = d.y;
          const [r, g, bl, a] = baseColor(d.row01);
          b.fillStyle = `rgba(${r}, ${g}, ${bl}, ${a})`;
          b.beginPath();
        }
        b.moveTo(d.x + radius, d.y);
        b.arc(d.x, d.y, radius, 0, Math.PI * 2);
      }
      if (!Number.isNaN(row)) b.fill();
    }

    /** Draws one frame; returns whether any flare is still alive. */
    function draw(now: number) {
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.drawImage(base, 0, 0);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const i of active) {
        const d = dots[i];
        const elapsed = now - d.lit;
        if (elapsed >= d.life) {
          active.delete(i);
          continue;
        }
        const k = twinkle(elapsed, d.life, d.phase) * d.peak;
        if (k <= 0) continue;
        ctx!.fillStyle = `rgba(${HALO_RGB}, ${0.22 * k})`;
        ctx!.beginPath();
        ctx!.arc(d.x, d.y, radius * (1.6 + 1.6 * k), 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = `rgba(${FLARE_RGB}, ${Math.min(1, 0.35 + 0.7 * k)})`;
        ctx!.beginPath();
        ctx!.arc(d.x, d.y, radius * (1 + 1.6 * k), 0, Math.PI * 2);
        ctx!.fill();
      }
      return active.size > 0;
    }

    function tick(now: number) {
      raf = 0;
      if (draw(now)) raf = requestAnimationFrame(tick);
    }

    function layout() {
      const { width, height } = wrap!.getBoundingClientRect();
      // A hidden or collapsed wrapper: a zero-size canvas throws on drawImage.
      if (width < 1 || height < 1) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = base.width = Math.round(width * dpr);
      canvas!.height = base.height = Math.round(height * dpr);
      const pitch = pitchFor(width);
      radius = pitch * DOT_SHARE;
      dots = buildGrid(width, height, pitch, glyphMask(width, height, family));
      active.clear();
      paintBase();
      draw(performance.now());
    }

    function ignite(a: { x: number; y: number }, b: { x: number; y: number }) {
      if (reduced.matches || dots.length === 0) return;
      const now = performance.now();
      for (const [i, strength] of dotsNearSegment(dots, a.x, a.y, b.x, b.y, TRAIL_RADIUS)) {
        const d = dots[i];
        const peak = strength * (0.7 + 0.3 * Math.random());
        const current = active.has(i) ? twinkle(now - d.lit, d.life, d.phase) * d.peak : 0;
        // Never dim a dot that is already brighter than this pass would make it.
        if (peak <= current) continue;
        d.lit = now;
        d.peak = peak;
        d.life = FLARE_MS * (0.7 + 0.6 * Math.random());
        d.phase = Math.random() * Math.PI * 2;
        active.add(i);
      }
      if (active.size > 0 && !raf) raf = requestAnimationFrame(tick);
    }

    const at = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      const p = at(e);
      ignite(last ?? p, p);
      last = p;
    };
    const onDown = (e: PointerEvent) => {
      const p = at(e);
      ignite(p, p);
      last = p;
    };
    // A touch has no hover, so the next one must not draw a line from where this one ended.
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") last = null;
    };
    const onLeave = () => {
      last = null;
    };
    const onReducedChange = () => {
      active.clear();
      draw(performance.now());
    };

    const ro = new ResizeObserver(layout);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointercancel", onLeave);
    reduced.addEventListener("change", onReducedChange);
    // Sample the letters in the real face, not the fallback it swaps from. The heading
    // font is almost always loaded by the time the page bottom mounts.
    document.fonts
      .load(`${WEIGHT} 100px ${family}`, "Orbit")
      .catch(() => undefined)
      .then(() => {
        if (!disposed) ro.observe(wrap);
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointercancel", onLeave);
      reduced.removeEventListener("change", onReducedChange);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      data-footer-wordmark=""
      aria-hidden="true"
      className={cn("relative w-full select-none", className)}
      style={{ aspectRatio: `${INK_WIDTH} / ${VIEW_H}` }}
    >
      {/* touch-pan-y: a vertical swipe still scrolls the page, a sideways drag draws. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full touch-pan-y font-[family-name:var(--font-display)]"
      />
    </div>
  );
}
