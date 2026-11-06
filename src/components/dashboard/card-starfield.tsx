"use client";

import { useEffect, useRef } from "react";
import { STAR_GOLD, STAR_WHITE, paintSpace } from "@/lib/sky-palette";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * The landing page's sky, sized to a card.
 *
 * Same ingredients as `components/landing/starfield.tsx` — `paintSpace`'s deep-space gradient
 * and nebulae, the same star colours, radii, brightness range, gold share and bloom stars,
 * at the same density — so a card of it reads as a window onto that sky rather than as a
 * lookalike. What it leaves out is everything about being the page's background: no scroll
 * parallax, no pointer well, no constellations, no shooting stars.
 *
 * The sky is painted once at a fixed height, taller than the card ever gets, and the card
 * clips it. Opening the card therefore reveals more of a sky that is already there; nothing
 * is resized, stretched or redrawn while it animates, so no star can move. (Following the
 * card's own height instead stretched the old bitmap every frame of the open animation until
 * the next redraw caught up, and drew a different random set at each size before that.) Only a
 * change of width, i.e. the window resizing, repaints it, with the same stars at the same
 * pixel positions. Twinkle runs at a low frame rate and only while the card is on screen;
 * reduced motion gets one still frame.
 */
const STAR_AREA = 2650;
const WHITE_FILL = `rgb(${STAR_WHITE})`;
const GOLD_FILL = `rgb(${STAR_GOLD})`;
const BLOOM_SHADOW = `rgba(${STAR_GOLD}, 0.8)`;
const FRAME_MS = 66;
/** The pool is laid out over this much sky; a card never gets larger than the page column. */
const POOL_W = 2000;
/** Taller than the numbers card at its most open (one column on a phone, six tiles). */
const SKY_H = 1200;

type Star = { x: number; y: number; r: number; a: number; twinkle: number; phase: number; gold: boolean; bloom: boolean };

export function CardStarfield({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !parent || !ctx) return;

    let width = 0;
    const height = SKY_H;
    // Laid out once per mount, not per size — see the header.
    const stars: Star[] = Array.from({ length: Math.floor((POOL_W * SKY_H) / STAR_AREA) }, () => {
      const gold = Math.random() < 0.04;
      return {
        x: Math.random() * POOL_W,
        y: Math.random() * SKY_H,
        r: Math.random() * 1.4 + 0.3,
        a: Math.random() * 0.55 + 0.25,
        twinkle: Math.random() * 0.008 + 0.004,
        phase: Math.random() * Math.PI * 2,
        gold,
        bloom: gold && Math.random() < 0.35,
      };
    });
    let bg: HTMLCanvasElement | null = null;
    let raf = 0;
    let last = 0;
    let visible = true;

    function draw(now: number) {
      ctx!.globalAlpha = 1;
      if (bg) ctx!.drawImage(bg, 0, 0, width, height);
      for (const s of stars) {
        if (s.x > width || s.y > height) continue;
        const alpha = reduced ? s.a : s.a * (0.65 + 0.35 * Math.sin(now * s.twinkle + s.phase));
        if (s.bloom) {
          ctx!.shadowBlur = 6;
          ctx!.shadowColor = BLOOM_SHADOW;
        }
        ctx!.beginPath();
        ctx!.fillStyle = s.gold ? GOLD_FILL : WHITE_FILL;
        ctx!.globalAlpha = alpha;
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
        if (s.bloom) ctx!.shadowBlur = 0;
      }
      ctx!.globalAlpha = 1;
    }

    function resize() {
      const w = parent!.clientWidth;
      // Height changes are the card opening and closing: nothing to do. Only width matters.
      if (w < 1 || w === width) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = w;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // The base is painted once into its own layer, as the landing sky does; a frame is then
      // one image blit plus the stars.
      const off = document.createElement("canvas");
      off.width = canvas!.width;
      off.height = canvas!.height;
      const bctx = off.getContext("2d");
      if (bctx) {
        bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintSpace(bctx, width, height);
        bg = off;
      }

      draw(performance.now());
    }

    function loop(now: number) {
      raf = requestAnimationFrame(loop);
      if (!visible || now - last < FRAME_MS) return;
      last = now;
      draw(now);
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    const io = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
    });
    io.observe(canvas);
    if (!reduced) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className ?? "pointer-events-none absolute left-0 top-0"}
    />
  );
}
