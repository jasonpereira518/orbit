"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { easeHouse, easeIn } from "@/lib/warp/choreography";
import {
  GATHER,
  MAX_STARS,
  REST,
  SETTLE,
  SHOWER,
  type CreditsIntroPhase,
  type CreditsIntroTheme,
} from "@/lib/credits-intro-scene";

/** The medallion's radius for a viewport — big enough to seat the 96px hero mark. */
export function medallionRadius(w: number, h: number): number {
  return Math.max(60, Math.min(96, Math.min(w, h) * 0.13));
}

/** Deterministic, so a skip lands on the same sky a full play arrives at. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Star = { a: number; r0: number; delay: number; size: number };
type Mote = { x0: number; delay: number; size: number };

/** The orbit sits just outside the medallion. */
const ORBIT_GAP = 14;
/** One lap of the satellite every 14 seconds: alive, never busy. */
const ORBIT_RAD_PER_MS = (Math.PI * 2) / 14_000;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The cluster: one canvas, one rAF, every frame derived from elapsed time against
 * `src/lib/credits-intro-scene.ts`. Phase and t0 arrive through refs so a React phase change
 * never restarts the loop, and `t = phase === "rest" ? max(raw, REST) : raw` makes a skip jump
 * forward to exactly the composition a full play reaches.
 *
 * Layers, back to front: a baked field of faint background stars; the medallion disc (from
 * SETTLE); the month's stars spiralling in and dissolving into one orbit ring, which draws
 * itself clockwise as their light arrives; and a single satellite riding that orbit from SETTLE
 * on. On Free the starter shower falls from above and lands on that satellite.
 */
export function CreditsIntroCanvas({
  theme,
  starCount,
  showerCount,
  phaseRef,
  t0Ref,
}: {
  theme: CreditsIntroTheme;
  starCount: number;
  showerCount: number;
  phaseRef: RefObject<CreditsIntroPhase>;
  t0Ref: RefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let w = 0;
    let h = 0;
    let field: HTMLCanvasElement | null = null;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The background sky is baked once per size: it never moves, so it never redraws.
      field = document.createElement("canvas");
      field.width = canvas.width;
      field.height = canvas.height;
      const f = field.getContext("2d")!;
      f.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rand = rng(7);
      for (let i = 0; i < 140; i++) {
        f.fillStyle = `rgba(255,255,255,${0.08 + rand() * 0.22})`;
        f.beginPath();
        f.arc(rand() * w, rand() * h, 0.4 + rand() * 0.9, 0, Math.PI * 2);
        f.fill();
      }
    };
    resize();
    window.addEventListener("resize", resize);

    const rand = rng(42);
    const nStars = Math.min(starCount, MAX_STARS);
    const stars: Star[] = Array.from({ length: nStars }, (_, i) => ({
      a: (i / nStars) * Math.PI * 2 + rand() * 0.15,
      r0: 0.75 + rand() * 0.5,
      delay: rand() * 600,
      size: 1.3 + rand() * 1.4,
    }));
    const nMotes = Math.min(showerCount, 40);
    const motes: Mote[] = Array.from({ length: nMotes }, () => ({
      x0: (rand() - 0.5) * 2.6,
      delay: rand() * 280,
      size: 1.6 + rand() * 1.2,
    }));

    const dot = (x: number, y: number, r: number, rgb: string, alpha: number) => {
      if (alpha <= 0) return;
      ctx.fillStyle = `rgba(${rgb},${alpha * 0.22})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };

    let raf = 0;
    const TOP = -Math.PI / 2;
    // The satellite rides the orbit from the moment the medallion settles. Its position derives
    // from `t`, so a skip lands it where a full play would.
    const orbitAngle = (t: number) => TOP + Math.max(0, t - SETTLE) * ORBIT_RAD_PER_MS;

    const frame = (now: number) => {
      const raw = now - t0Ref.current;
      const t = phaseRef.current === "rest" ? Math.max(raw, REST) : raw;
      const R = medallionRadius(w, h);
      const orbit = R + ORBIT_GAP;
      const cx = w / 2;
      const cy = Math.round(h * 0.4);
      const far = Math.hypot(w, h) / 2;

      ctx.clearRect(0, 0, w, h);
      if (field) ctx.drawImage(field, 0, 0, w, h);

      // The medallion forms as the last stars arrive.
      const form = easeHouse(clamp01((t - (SETTLE - 250)) / 500));
      if (form > 0) {
        ctx.fillStyle = theme.disc;
        ctx.globalAlpha = form;
        ctx.beginPath();
        ctx.arc(cx, cy, R * (0.82 + 0.18 * form), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // The month's credits spiral in and dissolve into the orbit. How much of the ring is lit
      // is how much of the light has arrived.
      const span = GATHER[1] - GATHER[0] - 600;
      let arrived = 0;
      for (const s of stars) {
        const p = clamp01((t - GATHER[0] - s.delay) / span);
        const e = easeHouse(p);
        // Linear, not eased: the eased value is ~1 long before a star lands, which lit the whole
        // ring while light was still streaming in.
        arrived += p;
        if (p >= 1) continue;
        const r = orbit + (s.r0 * far - orbit) * (1 - e);
        const a = s.a + (1 - e) * 1.1;
        dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, s.size, theme.rimRgb, Math.min(1, p * 3) * (1 - clamp01((p - 0.82) / 0.18)));
      }
      const lit = nStars ? arrived / nStars : 1;

      // The orbit: a faint track, then the lit arc drawing clockwise from the top.
      const track = clamp01(t / 600);
      ctx.lineCap = "round";
      ctx.strokeStyle = `rgba(${theme.rimRgb},${0.18 * track})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, orbit, 0, Math.PI * 2);
      ctx.stroke();
      if (lit > 0.002) {
        const end = TOP + lit * Math.PI * 2;
        ctx.strokeStyle = `rgba(${theme.rimRgb},0.16)`;
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.arc(cx, cy, orbit, TOP, end);
        ctx.stroke();
        ctx.strokeStyle = theme.rim;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, orbit, TOP, end);
        ctx.stroke();
      }

      // Free's starter credits: fall from above and land on the satellite itself — one body on
      // the orbit on every plan, and on Free it swells a little as the starter arrives.
      let landed = 0;
      if (nMotes) {
        const landA = orbitAngle(SHOWER[1]);
        const lx = cx + Math.cos(landA) * orbit;
        const ly = cy + Math.sin(landA) * orbit;
        for (const m of motes) {
          const p = clamp01((t - SHOWER[0] - m.delay) / (SHOWER[1] - SHOWER[0] - 280));
          if (p >= 1) landed++;
          if (p <= 0 || p >= 1) continue;
          const e = easeIn(p);
          const sx = cx + m.x0 * R;
          const sy = -20;
          dot(sx + (lx - sx) * e, sy + (ly - sy) * e, m.size, theme.goldRgb, Math.min(1, p * 4));
        }
      }

      // The satellite: one bright body that keeps circling once everything has landed.
      const sat = easeHouse(clamp01((t - SETTLE) / 400));
      if (sat > 0) {
        const a = orbitAngle(t);
        const fed = nMotes ? landed / nMotes : 0;
        dot(cx + Math.cos(a) * orbit, cy + Math.sin(a) * orbit, (5.5 + 1.5 * fed) * (0.6 + 0.4 * sat), theme.rimRgb, sat);
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [theme, starCount, showerCount, phaseRef, t0Ref]);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0" />;
}
