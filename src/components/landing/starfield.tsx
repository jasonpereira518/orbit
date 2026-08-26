"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

type Star = {
  x: number;
  /** Position within the virtual field, NOT the viewport. See FIELD_MULT. */
  y: number;
  r: number;
  a: number;
  twinkle: number;
  phase: number;
  gold: boolean;
  bloom: boolean;
};

type ShootingStar = {
  x: number;
  y: number;
  len: number;
  speed: number;
  life: number;
  maxLife: number;
  angle: number;
};

/** The star field is this many viewports tall and wraps vertically. The
 * canvas itself stays viewport-sized: sizing it to the page's scrollHeight
 * (~10,000px here) would allocate a ~300MB backing store at DPR 2 and blow
 * past iOS Safari's canvas-area cap, where the canvas silently blanks. */
const FIELD_MULT = 2;
/** Stars drift at a fraction of scroll speed, so the sky reads as far away.
 * The field repeats every FIELD_MULT / PARALLAX ≈ 5.7 viewports — once on a
 * page this long, and invisible in a landmark-free random field. */
const PARALLAX = 0.35;
/** One star per this many virtual px² — raise it to thin the sky out. Cap
 * keeps the per-frame arc count bounded on ultrawide displays. */
const STAR_AREA = 2650;
const STAR_CAP = 1400;

/** Soft gas clouds, painted once into the background layer. Positions and
 * radii are fractions of the viewport so they hold their composition at any
 * size; radii are both scaled by WIDTH so a nebula keeps its aspect instead
 * of stretching on short windows. Alphas are deliberately low — these should
 * register as depth, not as scenery. */
const NEBULAE = [
  // Violet, upper left — the largest, sits behind the hero copy.
  { x: 0.16, y: 0.24, rx: 0.46, ry: 0.3, rot: -0.35, rgb: "104, 96, 214", a: 0.1 },
  // Blue, lower right — balances the solar system's side of the frame.
  { x: 0.84, y: 0.72, rx: 0.42, ry: 0.26, rot: 0.42, rgb: "58, 104, 198", a: 0.09 },
  // Faint cyan low centre, mostly off-frame — keeps the bottom from going flat.
  { x: 0.52, y: 1.02, rx: 0.34, ry: 0.2, rot: 0.1, rgb: "46, 122, 158", a: 0.055 },
] as const;

export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let stars: Star[] = [];
    let shooters: ShootingStar[] = [];
    let nextShot = 0;
    let width = 0;
    let height = 0;
    let fieldH = 0;
    let dpr = 1;
    // The base gradient plus the nebulae are several full-screen radial
    // fills. Rebuilding those every frame was the most expensive op in the
    // loop, so they are rendered once per resize and blitted thereafter.
    let bg: HTMLCanvasElement | null = null;

    function paintBackground() {
      const off = document.createElement("canvas");
      off.width = Math.floor(width * dpr);
      off.height = Math.floor(height * dpr);
      const bctx = off.getContext("2d");
      if (!bctx) return;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Deep indigo, lifted slightly through the middle band and falling off
      // to near-black at the edges.
      const g = bctx.createRadialGradient(
        width * 0.5,
        height * 0.42,
        0,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.9
      );
      g.addColorStop(0, "#0f1630");
      g.addColorStop(0.42, "#0a1024");
      g.addColorStop(0.72, "#060915");
      g.addColorStop(1, "#03050c");
      bctx.fillStyle = g;
      bctx.fillRect(0, 0, width, height);

      // Nebulae composite with "screen" so they only ever lighten — over a
      // near-black base that keeps them glowing rather than milky, and means
      // overlaps blend instead of banding.
      for (const n of NEBULAE) {
        const rx = width * n.rx;
        const ry = width * n.ry;
        bctx.save();
        bctx.globalCompositeOperation = "screen";
        bctx.translate(width * n.x, height * n.y);
        bctx.rotate(n.rot);
        bctx.scale(1, ry / rx);
        const neb = bctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        neb.addColorStop(0, `rgba(${n.rgb}, ${n.a})`);
        neb.addColorStop(0.4, `rgba(${n.rgb}, ${n.a * 0.42})`);
        neb.addColorStop(0.72, `rgba(${n.rgb}, ${n.a * 0.12})`);
        neb.addColorStop(1, `rgba(${n.rgb}, 0)`);
        bctx.fillStyle = neb;
        bctx.beginPath();
        bctx.arc(0, 0, rx, 0, Math.PI * 2);
        bctx.fill();
        bctx.restore();
      }

      // Deepen the top-left corner toward black — "multiply" only darkens,
      // so it grounds that corner without dulling the nebula glow or
      // recoloring anything further into the frame.
      const corner = bctx.createRadialGradient(
        0,
        0,
        0,
        0,
        0,
        Math.max(width, height) * 0.65
      );
      corner.addColorStop(0, "rgba(0, 0, 0, 0.6)");
      corner.addColorStop(1, "rgba(0, 0, 0, 0)");
      bctx.save();
      bctx.globalCompositeOperation = "multiply";
      bctx.fillStyle = corner;
      bctx.fillRect(0, 0, width, height);
      bctx.restore();

      bg = off;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      fieldH = height * FIELD_MULT;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      paintBackground();

      const count = Math.min(Math.floor((width * fieldH) / STAR_AREA), STAR_CAP);
      stars = Array.from({ length: count }, () => {
        const gold = Math.random() < 0.04;
        return {
          x: Math.random() * width,
          y: Math.random() * fieldH,
          r: Math.random() * 1.4 + 0.3,
          a: Math.random() * 0.55 + 0.25,
          twinkle: Math.random() * 0.008 + 0.004,
          phase: Math.random() * Math.PI * 2,
          gold,
          bloom: gold && Math.random() < 0.35,
        };
      });

      if (reduced) draw(performance.now());
    }

    function spawnShooter(now: number) {
      shooters.push({
        x: Math.random() * width * 0.7 + width * 0.1,
        y: Math.random() * height * 0.35,
        len: Math.random() * 90 + 70,
        speed: Math.random() * 6 + 8,
        life: 0,
        maxLife: Math.random() * 28 + 22,
        angle: Math.PI / 4 + (Math.random() - 0.5) * 0.25,
      });
      nextShot = now + Math.random() * 2800 + 2200;
    }

    function draw(now: number) {
      ctx!.clearRect(0, 0, width, height);
      // A zero-size viewport at mount (hidden tab being restored, prerender) produces a
      // zero-size bg canvas, and drawImage throws InvalidStateError on those — which
      // would take down the whole page tree, not just the backdrop.
      if (bg && bg.width > 0 && bg.height > 0) {
        ctx!.drawImage(bg, 0, 0, width, height);
      }

      // Read scroll once per frame rather than binding a scroll listener —
      // the value is only ever consumed here.
      const yOff = reduced ? 0 : (window.scrollY * PARALLAX) % fieldH;

      for (const s of stars) {
        const y = ((s.y - yOff) % fieldH + fieldH) % fieldH;
        if (y < -8 || y > height + 8) continue;

        const alpha = reduced
          ? s.a
          : s.a * (0.65 + 0.35 * Math.sin(now * s.twinkle + s.phase));

        if (s.bloom) {
          ctx!.shadowBlur = 6;
          ctx!.shadowColor = "rgba(242, 193, 78, 0.8)";
        }
        ctx!.beginPath();
        ctx!.fillStyle = s.gold
          ? `rgba(242, 193, 78, ${alpha})`
          : `rgba(232, 243, 241, ${alpha})`;
        ctx!.arc(s.x, y, s.r, 0, Math.PI * 2);
        ctx!.fill();
        if (s.bloom) ctx!.shadowBlur = 0;
      }

      if (!reduced) {
        if (now >= nextShot && shooters.length < 2) {
          spawnShooter(now);
        }

        shooters = shooters.filter((shot) => {
          shot.life += 1;
          const t = shot.life / shot.maxLife;
          const dist = shot.speed * shot.life;
          const x = shot.x + Math.cos(shot.angle) * dist;
          const y = shot.y + Math.sin(shot.angle) * dist;
          const opacity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;

          if (opacity <= 0 || x > width + 40 || y > height + 40) {
            return false;
          }

          const tailX = x - Math.cos(shot.angle) * shot.len;
          const tailY = y - Math.sin(shot.angle) * shot.len;
          const streak = ctx!.createLinearGradient(tailX, tailY, x, y);
          streak.addColorStop(0, "rgba(232, 243, 241, 0)");
          streak.addColorStop(0.7, `rgba(196, 220, 230, ${opacity * 0.45})`);
          streak.addColorStop(1, `rgba(255, 255, 255, ${opacity * 0.95})`);

          ctx!.strokeStyle = streak;
          ctx!.lineWidth = 1.5;
          ctx!.lineCap = "round";
          ctx!.beginPath();
          ctx!.moveTo(tailX, tailY);
          ctx!.lineTo(x, y);
          ctx!.stroke();

          ctx!.beginPath();
          ctx!.fillStyle = `rgba(255, 255, 255, ${opacity})`;
          ctx!.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx!.fill();

          return true;
        });
      }

      if (!reduced) {
        raf = requestAnimationFrame(draw);
      }
    }

    // Don't burn battery repainting a starfield in a background tab.
    function onVisibility() {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) {
        raf = requestAnimationFrame(draw);
      }
    }

    // Listeners attach before the first draw so that if the viewport is zero-sized at
    // mount, the resize event that gives it real dimensions can still repair the field.
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);

    resize();
    nextShot = performance.now() + 800;
    draw(performance.now());
    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
    };
  }, [reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 h-full w-full"
    />
  );
}
