"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { easeHouse, easeIn } from "@/lib/warp/choreography";
import {
  ACCRETE,
  COLLAPSE,
  IGNITE,
  RING_SWEEP_MS,
  finaleAt,
  perkAt,
  restAt,
} from "@/lib/celebration/choreography";
import type { CelebrationPhase } from "@/lib/celebration/choreography";
import type { TierTheme } from "@/lib/celebration/tier-theme";
import { stageLayout } from "@/lib/celebration/stage-layout";
import type { StageLayout } from "@/lib/celebration/stage-layout";
import {
  MARK_RATIO,
  drawEmblem,
  drawMarkSkeleton,
  sparkPath,
} from "@/lib/celebration/emblem";

/**
 * The celebration's field and its emblem: one canvas, one rAF, every beat
 * derived from elapsed celebration time. Phase and t0 arrive through refs so
 * a React phase change never restarts the loop — the loop derives everything
 * from `t` and a pair of one-shot latches.
 *
 * The clock: `t = phase === "rest" ? max(raw, restAt) : raw`. A skip jumps
 * forward, never freezes, and both latches fire off `t` — so a skip lands on
 * exactly the composition a full play arrives at, minus the transients that
 * would already be dead (their latches spawn nothing when they fire late).
 *
 * The field is two offscreen bakes, dim and lit, cross-faded by `energy`.
 * That is what makes the ignition flip the whole screen bright: there is no
 * additive surge anywhere, just a blend between two versions of the same
 * ground, which can never mud because one is literally the other darkened.
 */

type Shard = {
  angle: number;
  radius: number;
  speed: number;
  len: number;
  spin: number;
  spinRate: number;
  tone: number;
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

type Confetto = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  spin: number;
  spinRate: number;
  tone: number;
  life: number;
  maxLife: number;
};

/** Flat shapes read far busier than dust, so there are a fifth as many. */
const SHARD_AREA = 16000;
const SHARD_CAP = 120;
const EJECTA_COUNT = 160;
const CONFETTI_COUNT = 36;
const GLINT_COUNT = 12;
/** A latch firing this far past its beat spawns nothing — the transient it
 * would have thrown is already notionally over. */
const LATCH_FRESH_MS = 600;
const RAY_COUNT = 24;

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

    let layout: StageLayout = stageLayout(window.innerWidth, window.innerHeight);
    const n = theme.perks.length;
    const FINALE = finaleAt(n);
    const REST = restAt(n);
    const SWEEP_DONE = FINALE + RING_SWEEP_MS;

    let raf = 0;
    let shards: Shard[] = [];
    let sparks: Spark[] = [];
    let confetti: Confetto[] = [];
    let bgLit: HTMLCanvasElement | null = null;
    let bgDim: HTMLCanvasElement | null = null;
    let ignited = false;
    let glinted = false;
    let lastFrame = performance.now();
    // An accumulator rather than `now * k`, so the rays can change speed at
    // the ignition without the whole fan jumping.
    let rayAngle = 0;
    let tiltKick = 0;
    let kickedThrough = -1;

    const maxR = () => Math.hypot(layout.width, layout.height) / 2;

    function spawnShard(): Shard {
      const markR = layout.emblemR * MARK_RATIO;
      return {
        angle: Math.random() * Math.PI * 2,
        radius: markR * (2.6 + Math.random() * 3.2),
        speed: 0,
        len: 7 + Math.random() * 11,
        spin: Math.random() * Math.PI * 2,
        spinRate: (Math.random() - 0.5) * 6,
        tone: Math.floor(Math.random() * 3),
      };
    }

    function spawnSparks(count: number, x: number, y: number, power: number) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = power * (0.25 + Math.random() * 0.75);
        const maxLife = 0.5 + Math.random() * 0.8;
        sparks.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: maxLife,
          maxLife,
          hot: i % 4 === 0,
        });
      }
    }

    function spawnConfetti(x: number, y: number) {
      for (let i = 0; i < CONFETTI_COUNT; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 620 * (0.3 + Math.random() * 0.7);
        const maxLife = 1.6 + Math.random();
        confetti.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s - 120,
          w: 4 + Math.random() * 3,
          h: 8 + Math.random() * 4,
          spin: Math.random() * Math.PI * 2,
          spinRate: (Math.random() - 0.5) * 10,
          tone: Math.floor(Math.random() * 3),
          life: maxLife,
          maxLife,
        });
      }
    }

    /**
     * The lit field, baked once per resize. Deliberately at DPR 1: these are
     * pure smooth gradients, so upscaling is invisible, and two DPR-2 bakes on
     * a 4K window would cost well over 100MB.
     */
    function paintField(g: CanvasRenderingContext2D, w: number, h: number) {
      const f = theme.field;
      g.fillStyle = f.mid;
      g.fillRect(0, 0, w, h);

      // Centred on the EMBLEM, not on the screen — the light source and the
      // object have to agree or the whole thing reads as a mistake.
      const hot = g.createRadialGradient(
        layout.cx,
        layout.cy,
        0,
        layout.cx,
        layout.cy,
        Math.hypot(w, h) * 0.72,
      );
      hot.addColorStop(0, f.hot);
      hot.addColorStop(0.42, f.mid);
      hot.addColorStop(1, f.edge);
      g.fillStyle = hot;
      g.fillRect(0, 0, w, h);

      // One centred inverse radial, not four corner gradients: on a flat
      // field the corner approach shows up as a lumpy X.
      const vig = g.createRadialGradient(
        layout.cx,
        layout.cy,
        0,
        layout.cx,
        layout.cy,
        Math.hypot(w, h) * 0.62,
      );
      vig.addColorStop(0, "rgba(255, 255, 255, 0)");
      vig.addColorStop(0.55, "rgba(255, 255, 255, 0)");
      vig.addColorStop(1, `rgba(${f.vignetteRgb}, 0.55)`);
      g.save();
      g.globalCompositeOperation = "multiply";
      g.fillStyle = vig;
      g.fillRect(0, 0, w, h);
      g.restore();
    }

    function resize() {
      if (!canvas || !ctx) return;
      layout = stageLayout(window.innerWidth, window.innerHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(layout.width * dpr);
      canvas.height = Math.round(layout.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Never bake a zero-sized canvas: a container can report 0 for a frame
      // during mount, and `drawImage` from a 0x0 source throws
      // InvalidStateError rather than no-opping. `frame` re-runs resize once
      // the viewport reports a real size.
      const w = Math.max(1, Math.round(layout.width));
      const h = Math.max(1, Math.round(layout.height));

      bgLit = document.createElement("canvas");
      bgLit.width = w;
      bgLit.height = h;
      const lit = bgLit.getContext("2d");
      if (lit) paintField(lit, w, h);

      // The dim bake IS the lit one darkened, so the cross-fade between them
      // is monotone and cannot shift hue.
      bgDim = document.createElement("canvas");
      bgDim.width = w;
      bgDim.height = h;
      const dim = bgDim.getContext("2d");
      if (dim && bgLit) {
        dim.drawImage(bgLit, 0, 0);
        dim.globalCompositeOperation = "multiply";
        dim.fillStyle = `rgba(${theme.field.vignetteRgb}, 0.62)`;
        dim.fillRect(0, 0, w, h);
        const deepen = dim.createRadialGradient(
          layout.cx,
          layout.cy,
          0,
          layout.cx,
          layout.cy,
          Math.hypot(w, h) * 0.62,
        );
        deepen.addColorStop(0, "rgba(255, 255, 255, 0)");
        deepen.addColorStop(1, `rgba(${theme.field.vignetteRgb}, 0.28)`);
        dim.fillStyle = deepen;
        dim.fillRect(0, 0, w, h);
      }

      if (!ignited) {
        const count = Math.min(
          SHARD_CAP,
          Math.round((layout.width * layout.height) / SHARD_AREA),
        );
        shards = Array.from({ length: count }, spawnShard);
      }
    }

    /**
     * The dark-to-bright knob: how much of the lit bake shows through. Not an
     * additive surge — there is no dark sky left to surge against.
     */
    function energyAt(t: number, now: number) {
      const HOLD_LOW = 0.1;
      if (t < COLLAPSE[0]) {
        return 0.28 + 0.36 * easeIn(Math.min(1, t / ACCRETE[1]));
      }
      if (t < IGNITE) {
        // The held breath. Crushes toward the field's own deep tone, never
        // toward black — black over a flat colour plane reads as a bug.
        const c = (t - COLLAPSE[0]) / (COLLAPSE[1] - COLLAPSE[0]);
        return 0.64 - (0.64 - HOLD_LOW) * easeHouse(c);
      }
      if (t < IGNITE + 150) {
        return HOLD_LOW + (1 - HOLD_LOW) * easeHouse((t - IGNITE) / 150);
      }
      if (t < FINALE) {
        return 0.62 + 0.38 * Math.max(0, 1 - (t - IGNITE - 150) / 900);
      }
      if (t < REST) {
        return 0.62 + 0.18 * Math.max(0, 1 - (t - FINALE) / RING_SWEEP_MS);
      }
      return 0.58 + 0.05 * Math.sin(now / 1400);
    }

    function frame(now: number) {
      if (!ctx || !bgLit || !bgDim) {
        raf = requestAnimationFrame(frame);
        return;
      }
      if (bgLit.width !== Math.max(1, Math.round(window.innerWidth))) {
        // Baked before the viewport had a real size (or a resize event was
        // missed). Re-bake rather than blitting a stretched 1px field.
        resize();
        if (!bgLit || !bgDim) {
          raf = requestAnimationFrame(frame);
          return;
        }
      }
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      const raw = now - (t0Ref.current ?? now);
      const t = phaseRef.current === "rest" ? Math.max(raw, REST) : raw;
      const { cx, cy, width, height, emblemR } = layout;
      const markR = emblemR * MARK_RATIO;
      const collapsing = t >= COLLAPSE[0] && t < IGNITE;

      if (!ignited && t >= IGNITE) {
        ignited = true;
        shards = [];
        if (t - IGNITE < LATCH_FRESH_MS) {
          spawnSparks(EJECTA_COUNT, cx, cy, 1000);
          spawnConfetti(cx, cy);
        }
      }
      if (!glinted && t >= SWEEP_DONE) {
        glinted = true;
        if (t - SWEEP_DONE < LATCH_FRESH_MS) {
          spawnSparks(GLINT_COUNT, cx, cy - emblemR, 320);
        }
      }

      const energy = energyAt(t, now);

      // The field: two blits, no gradients in the hot path.
      ctx.globalAlpha = 1;
      ctx.drawImage(bgDim, 0, 0, width, height);
      ctx.globalAlpha = energy;
      ctx.drawImage(bgLit, 0, 0, width, height);
      ctx.globalAlpha = 1;

      // Sunburst rays. White at very low alpha over a saturated field
      // lightens toward that field's own hotspot hue, so it never greys.
      rayAngle += (ignited ? 0.035 : 0.11) * dt;
      const rayA = 0.02 + 0.045 * energy;
      ctx.fillStyle = `rgba(255, 255, 255, ${rayA})`;
      for (let i = 0; i < RAY_COUNT; i += 2) {
        const a0 = rayAngle + (i * Math.PI * 2) / RAY_COUNT;
        const a1 = a0 + Math.PI / RAY_COUNT;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxR() * 1.5, a0, a1);
        ctx.closePath();
        ctx.fill();
      }

      if (!ignited) {
        // Shards fall straight in with a tangential curl. No tilted ellipse:
        // that is a 3D cue, and this is a flat poster.
        const p = Math.min(1, t / ACCRETE[1]);
        const attract = easeIn(p);
        const pull = (0.35 + attract * 1.2) * (collapsing ? 8 : 1);
        for (const s of shards) {
          s.radius -= (s.radius - markR) * pull * dt;
          s.angle +=
            1.4 * Math.pow(markR / Math.max(s.radius, 1), 0.8) * (0.6 + attract) * dt;
          s.spin += s.spinRate * dt;
          if (collapsing && s.radius < markR * 0.9) continue;
          const x = cx + Math.cos(s.angle) * s.radius;
          const y = cy + Math.sin(s.angle) * s.radius;
          const tone =
            s.tone === 0
              ? theme.emblem.highlight
              : s.tone === 1
                ? theme.emblem.light
                : "#FFFFFF";
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(s.angle + Math.PI / 2 + s.spin);
          // A solid chevron with a hard ink shadow — the flat-graphic mote.
          const drawChevron = (fill: string, ox: number, oy: number) => {
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.moveTo(ox, oy - s.len / 2);
            ctx.lineTo(ox + s.len * 0.28, oy + s.len / 2);
            ctx.lineTo(ox, oy + s.len * 0.22);
            ctx.lineTo(ox - s.len * 0.28, oy + s.len / 2);
            ctx.closePath();
            ctx.fill();
          };
          drawChevron(`rgba(${theme.inkRgb}, 0.35)`, 1.5, 1.5);
          drawChevron(tone, 0, 0);
          ctx.restore();
        }

        // The constellation strikes in, node by node, at exactly the centre
        // and size the emblem's mark will occupy.
        const nodeStrikeAt = (i: number) => 300 + i * 300;
        const NODE_SETTLE = 220;
        const EDGE_DRAW = 190;
        drawMarkSkeleton(ctx, cx, cy, markR, theme, {
          squeeze: collapsing
            ? 1 - 0.06 * easeHouse((t - COLLAPSE[0]) / (COLLAPSE[1] - COLLAPSE[0]))
            : 1,
          nodeAt: (i) =>
            Math.max(0, Math.min(1, (t - nodeStrikeAt(i)) / NODE_SETTLE)),
          edgeAt: (i) => {
            const after = Math.max(...[i, i + 1]);
            return Math.max(
              0,
              Math.min(1, (t - nodeStrikeAt(after) - 40) / EDGE_DRAW),
            );
          },
        });

        // The press: an oversized dark silhouette hanging over a crushed
        // field, motionless. The coiled spring before the strike.
        if (collapsing) {
          const c = (t - COLLAPSE[0]) / (COLLAPSE[1] - COLLAPSE[0]);
          ctx.save();
          ctx.globalAlpha = 0.55 * easeHouse(c);
          ctx.fillStyle = theme.emblem.contour;
          ctx.beginPath();
          ctx.arc(cx, cy, emblemR * 1.55, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      } else {
        // Two hard white rings. Source-over, not additive — an additive halo
        // is a light effect, and this is a graphic one.
        for (const delay of [0, 130]) {
          const wt = (t - IGNITE - delay) / 700;
          if (wt <= 0 || wt >= 1) continue;
          const eased = easeHouse(wt);
          ctx.save();
          ctx.globalAlpha = 0.75 * (1 - eased);
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 10 * (1 - eased) + 1;
          ctx.beginPath();
          ctx.arc(cx, cy, eased * maxR() * 1.1, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // One hard ring per perk — the emblem answers each line as it is
      // written in, so the list reads as something the emblem is emitting.
      for (let i = 0; i < n; i++) {
        const pt = (t - perkAt(i)) / 520;
        if (pt <= 0 || pt >= 1) continue;
        const eased = easeHouse(pt);
        ctx.save();
        ctx.globalAlpha = 0.3 * (1 - eased);
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 5 * (1 - eased) + 1;
        ctx.beginPath();
        ctx.arc(cx, cy, emblemR * (1 + eased * 1.2), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        if (kickedThrough < i) {
          kickedThrough = i;
          tiltKick += 0.1;
        }
      }
      tiltKick *= Math.pow(0.04, dt);

      // The emblem.
      const st = t - IGNITE;
      let scale = 1;
      let flash = 0;
      if (t < IGNITE) {
        scale = 0;
      } else {
        const snap = easeHouse(Math.min(1, st / 150));
        const wobble =
          st > 150
            ? Math.sin((st - 150) / 78) * 0.055 * Math.exp(-(st - 150) / 190)
            : 0;
        scale = 1.55 - 0.55 * snap + wobble;
        flash = Math.max(0, 1 - st / 180);
      }
      if (scale > 0) {
        drawEmblem(ctx, cx, cy, emblemR, theme, {
          forged: 1,
          scale,
          flash,
          alpha: 1,
          tilt: 0.22 * Math.sin(now / 2600) + tiltKick,
          ringLit:
            t >= FINALE ? easeHouse(Math.min(1, (t - FINALE) / RING_SWEEP_MS)) : 0,
        });
      }

      // The finale sweep: a white head running the emblem's own rim, leaving
      // the plan ring lit behind it.
      if (t >= FINALE && t < SWEEP_DONE + 400) {
        const sweep = Math.min(1, (t - FINALE) / RING_SWEEP_MS);
        const eased = easeHouse(sweep);
        const rr = emblemR * 0.978;
        if (sweep < 1) {
          const head = -Math.PI / 2 + eased * Math.PI * 2;
          const tail = Math.min(Math.PI * 0.66, eased * Math.PI * 2);
          const SEGMENTS = 40;
          for (let i = 0; i < SEGMENTS; i++) {
            const f = i / SEGMENTS;
            const a0 = head - tail * f;
            const a1 = head - tail * ((i + 1) / SEGMENTS);
            ctx.save();
            ctx.globalAlpha = 0.85 * (1 - f);
            ctx.strokeStyle = "#FFFFFF";
            ctx.lineWidth = emblemR * 0.1 * (1 - f) + 1;
            ctx.beginPath();
            ctx.arc(cx, cy, rr, a1, a0);
            ctx.stroke();
            ctx.restore();
          }
          const hx = cx + Math.cos(head) * rr;
          const hy = cy + Math.sin(head) * rr;
          ctx.fillStyle = "#FFFFFF";
          ctx.beginPath();
          ctx.arc(hx, hy, emblemR * 0.055, 0, Math.PI * 2);
          ctx.fill();
          sparkPath(ctx, hx, hy, emblemR * 0.14);
          ctx.save();
          ctx.globalAlpha = 0.7;
          ctx.fill();
          ctx.restore();
        }
      }

      // Sparks: bright chips with hard graphic shadows.
      sparks = sparks.filter((s) => s.life > 0);
      for (const s of sparks) {
        s.life -= dt;
        if (s.life <= 0) continue;
        s.vy += 60 * dt;
        const drag = Math.pow(0.25, dt);
        s.vx *= drag;
        s.vy *= drag;
        const px = s.x;
        const py = s.y;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const a = Math.max(0, s.life / s.maxLife);
        ctx.save();
        ctx.globalAlpha = a * 0.4;
        ctx.strokeStyle = `rgb(${theme.inkRgb})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px + 1.5, py + 1.5);
        ctx.lineTo(s.x + 1.5, s.y + 1.5);
        ctx.stroke();
        ctx.globalAlpha = a;
        ctx.strokeStyle = s.hot ? `rgb(${theme.coreRgb})` : "#FFFFFF";
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
        ctx.restore();
      }

      // Confetti: the biggest Battle-Pass read after the field itself. A 2D
      // tumble is a width scale, which is why these stay flat rects.
      confetti = confetti.filter((c) => c.life > 0);
      for (const c of confetti) {
        c.life -= dt;
        if (c.life <= 0) continue;
        c.vy += 420 * dt;
        const drag = Math.pow(0.55, dt);
        c.vx *= drag;
        c.vy *= drag;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.spin += c.spinRate * dt;
        const a = Math.min(1, c.life / (c.maxLife * 0.4));
        const tone =
          c.tone === 0
            ? "#FFFFFF"
            : c.tone === 1
              ? theme.emblem.highlight
              : theme.ink;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(c.x, c.y);
        ctx.scale(Math.abs(Math.cos(c.spin)), 1);
        ctx.fillStyle = `rgba(${theme.inkRgb}, 0.3)`;
        ctx.fillRect(-c.w / 2 + 1.5, -c.h / 2 + 1.5, c.w, c.h);
        ctx.fillStyle = tone;
        ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
        ctx.restore();
      }

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
