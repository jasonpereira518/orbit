"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { easeHouse, easeIn } from "@/lib/warp/choreography";
import {
  ACCRETE,
  CARD_FLIGHT_MS,
  COLLAPSE,
  IGNITE,
  RING_SWEEP_MS,
  cardAt,
  finaleAt,
  restAt,
} from "@/lib/celebration/choreography";
import type { CelebrationPhase } from "@/lib/celebration/choreography";
import type { TierTheme } from "@/lib/celebration/tier-theme";
import { cardFlight, stageLayout } from "@/lib/celebration/stage-layout";
import type { StageLayout } from "@/lib/celebration/stage-layout";

/**
 * The celebration's sky: one canvas, one rAF, every beat derived from
 * elapsed celebration time (warp-stage's contract). Phase and t0 arrive
 * through refs so a React phase change never restarts the loop — the loop
 * derives everything from `t` and a pair of one-shot latches.
 *
 * The clock: `t = phase === "rest" ? max(raw, restAt) : raw`. A skip jumps
 * forward, never freezes, and both latches fire off `t` — so a skip lands on
 * exactly the composition a full play arrives at, minus the transients that
 * would already be dead (their latches spawn nothing when they fire late).
 *
 * The "every pixel tinted" guarantee lives here: a static tier-hued space
 * base (rebuilt only on resize), a per-frame energy glow that surges the
 * tier colour with the arc, and ambient stars tinted `glowRgb`, never pure
 * white.
 */

type DiscParticle = {
  angle: number;
  /** Distance from the star centre, px. */
  radius: number;
  size: number;
  /** Previous painted position, for motion streaks. */
  px: number;
  py: number;
  seeded: boolean;
};

type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hot: boolean;
};

type AmbientStar = {
  angle: number;
  radius: number;
  size: number;
  twinkle: number;
};

/** Disc tilt: y compressed and the whole ellipse rotated a touch. */
const TILT_Y = 0.38;
const TILT_ROT = -0.2;

const DISC_AREA = 4500; // px² per disc particle
const DISC_CAP = 420;
const AMBIENT_AREA = 9000;
const AMBIENT_CAP = 180;
const EJECTA_COUNT = 160;
const GLINT_COUNT = 12;
/** A latch firing later than this spawns no transients — they'd be dead. */
const LATCH_FRESH_MS = 600;

export function CelebrationCanvas({
  theme,
  phaseRef,
  t0Ref,
}: {
  theme: TierTheme;
  phaseRef: RefObject<CelebrationPhase>;
  t0Ref: RefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const glow = theme.glowRgb;
    const core = theme.coreRgb;
    const n = theme.perks.length;
    const FINALE = finaleAt(n);
    const REST = restAt(n);
    const SWEEP_DONE = FINALE + RING_SWEEP_MS;

    let layout: StageLayout = stageLayout(window.innerWidth, window.innerHeight);
    let raf = 0;
    let background: HTMLCanvasElement | null = null;
    let disc: DiscParticle[] = [];
    let sparks: Spark[] = [];
    let ambient: AmbientStar[] = [];
    let ignited = false;
    let glinted = false;
    let lastFrame = performance.now();

    function maxR() {
      return Math.hypot(layout.width, layout.height) / 2;
    }

    /** Tilted-ellipse projection of a disc particle's polar position. */
    function discXY(p: { angle: number; radius: number }) {
      const ex = Math.cos(p.angle) * p.radius;
      const ey = Math.sin(p.angle) * p.radius * TILT_Y;
      const cosT = Math.cos(TILT_ROT);
      const sinT = Math.sin(TILT_ROT);
      return {
        x: layout.cx + ex * cosT - ey * sinT,
        y: layout.cy + ex * sinT + ey * cosT,
      };
    }

    function spawnDisc(): DiscParticle {
      return {
        angle: Math.random() * Math.PI * 2,
        radius: layout.coreR * (1.6 + Math.random() * 2.4),
        size: 0.6 + Math.random() * 1.3,
        px: 0,
        py: 0,
        seeded: false,
      };
    }

    function spawnAmbient(): AmbientStar {
      return {
        angle: Math.random() * Math.PI * 2,
        radius: maxR() * (0.15 + Math.random() * 0.95),
        size: 0.5 + Math.random() * 1.2,
        twinkle: Math.random() * Math.PI * 2,
      };
    }

    function spawnSparks(count: number, x: number, y: number, power: number) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = power * (0.3 + Math.random() * 0.7);
        const maxLife = 0.5 + Math.random() * 0.6;
        sparks.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: maxLife,
          maxLife,
          hot: i % 4 === 0,
        });
      }
    }

    /**
     * The tier-hued space base: `paintSpace`'s structure from
     * `sky-palette.ts`, with every stop and nebula sourced from the theme,
     * plus a vignette that multiplies the corners toward tier-black — never
     * neutral black, so even the darkest pixel carries the hue.
     */
    function paintTierSpace(bg: CanvasRenderingContext2D, w: number, h: number) {
      const g = bg.createRadialGradient(
        w * 0.5,
        h * 0.42,
        0,
        w * 0.5,
        h * 0.5,
        Math.max(w, h) * 0.9,
      );
      for (const s of theme.space) g.addColorStop(s.at, s.color);
      bg.fillStyle = g;
      bg.fillRect(0, 0, w, h);

      for (const neb of theme.nebulae) {
        const rx = w * neb.rx;
        const ry = w * neb.ry;
        bg.save();
        bg.globalCompositeOperation = "screen";
        bg.translate(w * neb.x, h * neb.y);
        bg.rotate(neb.rot);
        bg.scale(1, ry / rx);
        const cloud = bg.createRadialGradient(0, 0, 0, 0, 0, rx);
        cloud.addColorStop(0, `rgba(${neb.rgb}, ${neb.a})`);
        cloud.addColorStop(0.4, `rgba(${neb.rgb}, ${neb.a * 0.42})`);
        cloud.addColorStop(0.72, `rgba(${neb.rgb}, ${neb.a * 0.12})`);
        cloud.addColorStop(1, `rgba(${neb.rgb}, 0)`);
        bg.fillStyle = cloud;
        bg.beginPath();
        bg.arc(0, 0, rx, 0, Math.PI * 2);
        bg.fill();
        bg.restore();
      }

      bg.save();
      bg.globalCompositeOperation = "multiply";
      for (const [px, py] of [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ] as const) {
        const corner = bg.createRadialGradient(px, py, 0, px, py, Math.max(w, h) * 0.7);
        corner.addColorStop(0, `rgba(${theme.deepRgb}, 0.55)`);
        corner.addColorStop(1, "rgba(255, 255, 255, 0)");
        bg.fillStyle = corner;
        bg.fillRect(0, 0, w, h);
      }
      bg.restore();
    }

    function resize() {
      if (!canvas || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      layout = stageLayout(window.innerWidth, window.innerHeight);
      canvas.width = Math.round(layout.width * dpr);
      canvas.height = Math.round(layout.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      background = document.createElement("canvas");
      background.width = canvas.width;
      background.height = canvas.height;
      const bg = background.getContext("2d");
      if (bg) {
        bg.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintTierSpace(bg, layout.width, layout.height);
      }

      const area = layout.width * layout.height;
      ambient = Array.from(
        { length: Math.min(AMBIENT_CAP, Math.round(area / AMBIENT_AREA)) },
        spawnAmbient,
      );
      if (!ignited) {
        disc = Array.from(
          { length: Math.min(DISC_CAP, Math.round(area / DISC_AREA)) },
          spawnDisc,
        );
      }
    }

    /** Screen-wide tier-colour surge, the arc's emotional meter. */
    function energyAt(t: number, now: number) {
      if (t < COLLAPSE[0]) return 0.2 + 0.45 * easeIn(Math.min(1, t / ACCRETE[1]));
      if (t < IGNITE) return 0.65 - 0.3 * ((t - COLLAPSE[0]) / (COLLAPSE[1] - COLLAPSE[0]));
      if (t < FINALE) return 0.5 + 0.5 * Math.max(0, 1 - (t - IGNITE) / 900);
      if (t < REST) return 0.5 - 0.15 * ((t - FINALE) / (REST - FINALE));
      return 0.35 + 0.05 * Math.sin(now / 1200);
    }

    function frame(now: number) {
      if (!ctx || !background) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      const raw = now - (t0Ref.current ?? now);
      const t = phaseRef.current === "rest" ? Math.max(raw, REST) : raw;
      const { cx, cy, coreR, width, height } = layout;

      // One-shot latches, keyed to `t` so a skip fires them consistently.
      if (!ignited && t >= IGNITE) {
        ignited = true;
        // The disc is flung into the ambient field; fresh ignitions also get
        // the ejecta burst, late ones (skip, long frame gap) skip transients.
        for (const p of disc) {
          if (ambient.length >= AMBIENT_CAP * 1.4) break;
          ambient.push({
            angle: p.angle,
            radius: Math.max(p.radius, coreR * 1.2),
            size: p.size,
            twinkle: Math.random() * Math.PI * 2,
          });
        }
        disc = [];
        if (t - IGNITE < LATCH_FRESH_MS) spawnSparks(EJECTA_COUNT, cx, cy, 1000);
      }
      if (!glinted && t >= SWEEP_DONE) {
        glinted = true;
        if (t - SWEEP_DONE < LATCH_FRESH_MS) {
          spawnSparks(GLINT_COUNT, cx, cy - layout.ringRadius, 320);
        }
      }

      if (background.width > 0 && background.height > 0) {
        ctx.drawImage(background, 0, 0, width, height);
      }

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const energy = energyAt(t, now);
      const surge = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(width, height) * 0.7);
      surge.addColorStop(0, `rgba(${glow}, ${0.05 + 0.1 * energy})`);
      surge.addColorStop(1, `rgba(${glow}, 0)`);
      ctx.fillStyle = surge;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();

      // Ambient stars — tier-tinted, twinkling, drifting once the star burns.
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const drift = ignited ? 4 * dt : 0;
      for (const s of ambient) {
        s.radius += drift;
        if (s.radius > maxR() * 1.25) s.radius = maxR() * (0.1 + Math.random() * 0.4);
        const a = 0.2 + 0.16 * Math.sin(now / 900 + s.twinkle);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${glow}, ${a})`;
        ctx.arc(
          cx + Math.cos(s.angle) * s.radius,
          cy + Math.sin(s.angle) * s.radius,
          s.size,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      if (!ignited) {
        // ACCRETE / COLLAPSE — matter spiralling in on the tilted disc.
        const p = Math.min(1, t / ACCRETE[1]);
        const attract = easeIn(p);
        const collapsing = t >= COLLAPSE[0];
        const pull = (0.35 + attract * 1.2) * (collapsing ? 6 : 1);
        for (const d of disc) {
          d.radius -= (d.radius - coreR * 0.6) * pull * dt;
          d.angle +=
            0.9 * Math.pow(coreR / Math.max(d.radius, 1), 1.2) * (0.8 + attract) * dt * 4;
          if (!collapsing && d.radius < coreR * 0.75) {
            const fresh = spawnDisc();
            d.angle = fresh.angle;
            d.radius = fresh.radius;
            d.seeded = false;
          }
          const { x, y } = discXY(d);
          if (d.seeded) {
            // The tail stretches the per-frame delta so in-falling matter
            // reads as streaks, not dust — one frame of motion is invisible.
            const inner = d.radius < coreR * 1.5;
            ctx.beginPath();
            ctx.strokeStyle = inner
              ? `rgba(${core}, ${0.4 + attract * 0.35})`
              : `rgba(${glow}, ${0.22 + attract * 0.3})`;
            ctx.lineWidth = d.size;
            ctx.moveTo(x - (x - d.px) * 4, y - (y - d.py) * 4);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          d.px = x;
          d.py = y;
          d.seeded = true;
        }

        // The proto-star: growing, flickering, dimming a fraction as the
        // disc collapses — the intake of breath.
        const flicker = 1 + 0.06 * Math.sin(now / 47);
        const dim = collapsing ? 0.8 : 1;
        const growR = coreR * (0.25 + 0.75 * p) * flicker;
        const star = ctx.createRadialGradient(cx, cy, 0, cx, cy, growR);
        star.addColorStop(0, `rgba(${core}, ${0.9 * dim})`);
        star.addColorStop(0.45, `rgba(${glow}, ${0.4 * dim})`);
        star.addColorStop(1, `rgba(${glow}, 0)`);
        ctx.fillStyle = star;
        ctx.beginPath();
        ctx.arc(cx, cy, growR, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Shockwaves from the ignition.
        for (const delay of [0, 130]) {
          const wt = (t - IGNITE - delay) / 700;
          if (wt <= 0 || wt >= 1) continue;
          const eased = easeHouse(wt);
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${glow}, ${0.5 * (1 - eased)})`;
          ctx.lineWidth = 2.5 * (1 - eased) + 0.5;
          ctx.arc(cx, cy, eased * maxR() * 1.1, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Cascade guide arcs: each card's approach curve ghosts in for its
        // flight, then fades. Desktop only — narrow cards travel in flow.
        if (!layout.narrow) {
          for (let i = 0; i < n; i++) {
            const ft = (t - cardAt(i)) / CARD_FLIGHT_MS;
            if (ft <= 0 || ft >= 1.6) continue;
            const path = cardFlight(layout, i, n);
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${glow}, ${0.08 * (1 - Math.abs(ft - 0.5))})`;
            ctx.lineWidth = 1;
            ctx.moveTo(path.sx, path.sy);
            ctx.quadraticCurveTo(path.mx, path.my, path.ex, path.ey);
            ctx.stroke();
          }
        }

        // The burning star — contracting into a point through the finale so
        // the DOM logo can take its place under the falling brightness.
        const contractStart = FINALE - 250;
        let starScale = 1;
        let starAlpha = 1;
        if (t >= contractStart) {
          const ct = Math.min(1, (t - contractStart) / 450);
          const eased = easeHouse(ct);
          starScale = 1 - eased * (1 - 30 / (coreR * 1.6));
          starAlpha = 1 - eased;
        }
        if (starAlpha > 0.01) {
          const burn = 0.85 + 0.15 * Math.max(0, 1 - (t - IGNITE) / 900);
          const flicker = 1 + 0.04 * Math.sin(now / 41);
          const bodyR = coreR * 1.6 * starScale * flicker;
          const star = ctx.createRadialGradient(cx, cy, 0, cx, cy, bodyR);
          star.addColorStop(0, `rgba(${core}, ${0.95 * burn * starAlpha})`);
          star.addColorStop(0.35, `rgba(${glow}, ${0.5 * burn * starAlpha})`);
          star.addColorStop(1, `rgba(${glow}, 0)`);
          ctx.fillStyle = star;
          ctx.beginPath();
          ctx.arc(cx, cy, bodyR, 0, Math.PI * 2);
          ctx.fill();

          // Four diffraction spikes, rotating slowly.
          const spikeLen = coreR * 4 * starScale;
          const rot = now / 20000;
          for (const base of [0, Math.PI / 2]) {
            const a = base + rot;
            const x1 = cx + Math.cos(a) * spikeLen;
            const y1 = cy + Math.sin(a) * spikeLen;
            const x2 = cx - Math.cos(a) * spikeLen;
            const y2 = cy - Math.sin(a) * spikeLen;
            const spike = ctx.createLinearGradient(x1, y1, x2, y2);
            spike.addColorStop(0, `rgba(${core}, 0)`);
            spike.addColorStop(0.5, `rgba(${core}, ${0.35 * burn * starAlpha})`);
            spike.addColorStop(1, `rgba(${core}, 0)`);
            ctx.beginPath();
            ctx.strokeStyle = spike;
            ctx.lineWidth = 1.5;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }
        }

        // Ring ignition: a white-hot head dragging a tier-coloured tail
        // around the logo's ring radius, then a breathing halo forever.
        if (t >= FINALE) {
          const rr = layout.ringRadius;
          const sweep = Math.min(1, (t - FINALE) / RING_SWEEP_MS);
          const eased = easeHouse(sweep);
          const head = -Math.PI / 2 + eased * Math.PI * 2;
          if (sweep < 1) {
            const tail = Math.min(Math.PI * 0.66, eased * Math.PI * 2);
            const segments = 40;
            for (let k = 0; k < segments; k++) {
              const a0 = head - (tail * k) / segments;
              const a1 = head - (tail * (k + 1)) / segments;
              const fade = 1 - k / segments;
              ctx.beginPath();
              ctx.strokeStyle = `rgba(${glow}, ${0.75 * fade})`;
              ctx.lineWidth = 3.5 * fade + 0.8;
              ctx.arc(cx, cy, rr, a1, a0);
              ctx.stroke();
            }
            const hx = cx + Math.cos(head) * rr;
            const hy = cy + Math.sin(head) * rr;
            const headGlow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 12);
            headGlow.addColorStop(0, `rgba(${core}, 0.9)`);
            headGlow.addColorStop(1, `rgba(${glow}, 0)`);
            ctx.fillStyle = headGlow;
            ctx.beginPath();
            ctx.arc(hx, hy, 12, 0, Math.PI * 2);
            ctx.fill();
          } else {
            const breathe = 0.22 + 0.05 * Math.sin(now / 900);
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${glow}, ${breathe})`;
            ctx.lineWidth = 3;
            ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${glow}, 0.08)`;
            ctx.lineWidth = 10;
            ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      // Sparks — ignition ejecta and the ring glint share one pool.
      if (sparks.length > 0) {
        const alive: Spark[] = [];
        for (const s of sparks) {
          s.life -= dt;
          if (s.life <= 0) continue;
          s.vy += 60 * dt;
          const drag = Math.pow(0.25, dt);
          s.vx *= drag;
          s.vy *= drag;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          const a = Math.max(0, s.life / s.maxLife);
          ctx.beginPath();
          ctx.strokeStyle = s.hot ? `rgba(${core}, ${0.8 * a})` : `rgba(${glow}, ${0.6 * a})`;
          ctx.lineWidth = 1.2;
          ctx.moveTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
          alive.push(s);
        }
        sparks = alive;
      }

      ctx.restore();
      raf = requestAnimationFrame(frame);
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        cancelAnimationFrame(raf);
      } else {
        lastFrame = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }

    resize();
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [theme, phaseRef, t0Ref]);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}
