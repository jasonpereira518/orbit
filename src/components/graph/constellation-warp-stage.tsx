"use client";

import { useEffect, useRef } from "react";
import {
  INTRO_RESERVE_FRACTION,
  introCoverage,
  introFrame,
} from "@/lib/graph/intro-choreography";
import type { IntroRun } from "@/lib/graph/intro-signal";
import {
  burstForRadiusRank,
  CHRONO_OUTBOUND_MS,
  IGNITION_FRACTIONS,
  POLE,
  type ChronoFrame,
  type ChronoPhase,
} from "@/lib/warp/chrono";

/**
 * The constellation's long-exposure intro, scoped to the canvas box.
 *
 * A deliberate sibling of `src/components/warp/chrono-stage.tsx` rather than a variant of it.
 * That one drives the `/upgrade` transition and is dense with concerns this has none of —
 * route-swap cover, `covered` pinning for skip, inbound/landing legs, and a click-swallowing
 * rule written specifically to protect Stripe buttons. Branching all of that on a mode prop
 * would make both files worse, and that file is live. The shared part — the timing — is shared
 * properly, through `introFrame`, which is `chronoFrame` with a faster collapse and a longer
 * hold.
 *
 * It paints NO sky of its own. `paintSpace()`'s gradient and nebulae are a different sky from
 * the graph's `.constellation-milky-way`, so cross-fading one into the other would be a
 * luminance step at the exact moment of the payoff. Instead the canvas is transparent except
 * for the trail layer, and the ground showing through is the graph's own — so the hand-off is
 * invisible by construction rather than by matching two palettes by hand.
 */

type Star = {
  radius: number;
  angle: number;
  r: number;
  gold: boolean;
  /** Which ignition burst lights this star; -1 for one that was always there. */
  burst: number;
  flash: number;
  ignited: boolean;
  born: number;
};

const STAR_AREA = 2400;
const STAR_CAP = 1100;
const SEED_FRACTION = 0.12;
/** Keeps the innermost radii empty so the pole never reads as a bullseye. */
const CORE = 0.07;
/** A backgrounded tab returns with an enormous delta; without this the field snaps a whole
 *  revolution in one frame. Belt and braces alongside the visibility pause below. */
const MAX_DT = 0.05;
const FLASH_DECAY = 3.2;
const RESERVE_BORN = 0.99;

const STAR_WHITE = "255,255,255";
const STAR_GOLD = "255,214,140";

function chronoPhaseOf(status: IntroRun["status"]): ChronoPhase {
  if (status === "arriving" || status === "done") return "arriving";
  return "outbound";
}

export function ConstellationWarpStage({ run }: { run: IntroRun }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The loop reads the run through a ref so a phase change never restarts it — restarting
  // would rebuild the field and throw away the accumulated exposure, which IS the effect.
  // Synced after commit rather than during render, matching `chrono-stage.tsx`: the loop picks
  // the new value up on its next frame, 16ms it will never notice.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let poleX = 0;
    let poleY = 0;
    let maxR = 0;
    let stars: Star[] = [];
    let trail: HTMLCanvasElement | null = null;
    let trailCtx: CanvasRenderingContext2D | null = null;

    function frameNow(now: number): ChronoFrame {
      const r = runRef.current;
      return introFrame(
        chronoPhaseOf(r.status),
        now - r.startedAt,
        r.arrivingAt === null ? 0 : now - r.arrivingAt
      );
    }

    /**
     * Whether a star is alight in this frame.
     *
     * Shared by the draw loop and the field builder deliberately: a field built mid-run has to
     * agree with the very next frame about what is already lit, or every one of those stars
     * takes the ignition branch at once and the whole sky flares gold.
     */
    function isLit(f: ChronoFrame, burst: number, born: number) {
      return burst >= 0 && f.bursts > burst && born < f.alive;
    }

    function newStar(burst: number, born: number, f: ChronoFrame): Star {
      return {
        // sqrt keeps areal density even; CORE holds the knot at the pole open.
        radius: maxR * (CORE + (1 - CORE) * Math.sqrt(Math.random())),
        angle: Math.random() * Math.PI * 2,
        r: Math.random() * 1.15 + 0.35,
        gold: Math.random() < 0.05,
        burst,
        flash: 0,
        ignited: isLit(f, burst, born),
        born,
      };
    }

    function buildField(now: number) {
      const count = Math.min(Math.floor((width * height) / STAR_AREA), STAR_CAP);
      const seeds = Math.floor(count * SEED_FRACTION);
      const f = frameNow(now);

      // Sorted by radius so growth spreads OUTWARD from the pole: the innermost `seeds` are
      // always present, and everything beyond ignites in a burst keyed to how far out it sits.
      const field = Array.from({ length: count }, () => newStar(-1, 0, f));
      field.sort((a, b) => a.radius - b.radius);
      stars = field.map((s, i) => {
        const grown = i >= seeds;
        const rank = grown ? (i - seeds) / Math.max(1, count - seeds) : 0;
        const burst = grown ? burstForRadiusRank(rank) : -1;
        return { ...s, burst, born: rank, ignited: isLit(f, burst, rank) };
      });

      // The reserve: stars only a hold can reach, so a long wait keeps filling the sky instead
      // of becoming a visible loop. Their burst indices start where the scripted seven end.
      const reserve = Math.floor(count * INTRO_RESERVE_FRACTION);
      const levels = Math.max(1, reserve);
      for (let i = 0; i < reserve; i += 1) {
        const burst = IGNITION_FRACTIONS.length + Math.floor((i / levels) * reserve);
        stars.push(newStar(burst, RESERVE_BORN, f));
      }
    }

    function resize(now: number) {
      const prevTrail = trail;
      const prevMaxR = maxR;

      dpr = Math.min(window.devicePixelRatio || 1, 2);
      // The container, not the window — this sits inside the canvas box, not over the page.
      width = parent!.clientWidth;
      height = parent!.clientHeight;
      // A ResizeObserver can fire before layout has given the parent a size.
      if (width < 2 || height < 2) return;

      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      poleX = width * POLE.x;
      poleY = height * POLE.y;
      maxR = Math.max(
        Math.hypot(poleX, poleY),
        Math.hypot(width - poleX, poleY),
        Math.hypot(poleX, height - poleY),
        Math.hypot(width - poleX, height - poleY)
      );

      // The trail layer is never cleared — that accumulation IS the exposure — so it is its own
      // canvas, composited over the ground each frame.
      const t = document.createElement("canvas");
      t.width = Math.floor(width * dpr);
      t.height = Math.floor(height * dpr);
      const tctx = t.getContext("2d");
      if (!tctx) return;
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Carry the exposure across a resize rather than starting blank. This matters more here
      // than on a route transition: the graph pane genuinely can be resized mid-run, by the
      // fullscreen toggle.
      if (prevTrail) tctx.drawImage(prevTrail, 0, 0, width, height);
      trail = t;
      trailCtx = tctx;

      if (stars.length > 0) {
        // Keep the field across a resize; rebuilding re-randomises every position mid-arc,
        // which reads as the sky being swapped out. Scaling radii holds the composition.
        const k = prevMaxR > 0 ? maxR / prevMaxR : 1;
        for (const s of stars) s.radius *= k;
        return;
      }
      buildField(now);
    }

    function draw(now: number) {
      raf = requestAnimationFrame(draw);
      const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_DT);
      last = now;
      if (!trail || !trailCtx || width < 2) return;

      const f = frameNow(now);

      ctx!.clearRect(0, 0, width, height);

      // The shutter. Erasing a fraction of the layer leaves the rest as trail: a low alpha
      // leaves long arcs, 1 leaves bare points.
      trailCtx.globalCompositeOperation = "destination-out";
      trailCtx.fillStyle = `rgba(0,0,0,${f.alpha})`;
      trailCtx.fillRect(0, 0, width, height);
      trailCtx.globalCompositeOperation = "source-over";

      const step = f.omega * dt;
      for (const s of stars) {
        s.angle += step;

        if (s.burst >= 0) {
          if (!isLit(f, s.burst, s.born)) {
            s.ignited = false;
            s.flash = 0;
            continue;
          }
          // Flare once, on the frame it comes alight — `flash` decays to 0, so a decayed flare
          // is indistinguishable from one that never fired without this flag.
          if (!s.ignited) {
            s.ignited = true;
            s.flash = 1;
          }
        }

        // Decay before the off-screen cull: `flash` does not depend on position, and a star
        // that ignites off-screen must still decay in real time or it freezes at full flare
        // and swims into view later, unrelated to any burst boundary.
        const flare = s.flash;
        if (flare > 0) s.flash = Math.max(0, flare - dt * FLASH_DECAY);

        const x = poleX + Math.cos(s.angle) * s.radius;
        const y = poleY + Math.sin(s.angle) * s.radius;
        if (x < -8 || x > width + 8 || y < -8 || y > height + 8) continue;

        const rgb = s.gold || flare > 0.15 ? STAR_GOLD : STAR_WHITE;
        trailCtx.fillStyle = `rgba(${rgb},${0.55 + flare * 0.45})`;
        trailCtx.beginPath();
        trailCtx.arc(x, y, s.r * (1 + flare * 2.2), 0, Math.PI * 2);
        trailCtx.fill();
      }

      // `lighter` so trails add light over the ground rather than punching a hole in it.
      ctx!.globalCompositeOperation = "lighter";
      ctx!.drawImage(trail, 0, 0, width, height);
      ctx!.globalCompositeOperation = "source-over";

      const r = runRef.current;
      canvas!.style.opacity = String(
        introCoverage(
          chronoPhaseOf(r.status),
          now - r.startedAt,
          r.arrivingAt === null ? 0 : now - r.arrivingAt
        )
      );
    }

    // Don't burn battery spinning in a background tab. The controller shifts `startedAt` by the
    // hidden span on resume, so the animation continues from where it paused rather than
    // jumping to wherever the clock had run to.
    function onVisibility() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(draw);
    }

    const ro = new ResizeObserver(() => resize(performance.now()));
    ro.observe(parent);
    document.addEventListener("visibilitychange", onVisibility);

    resize(performance.now());
    raf = requestAnimationFrame(draw);

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
      style={{ opacity: 0 }}
    />
  );
}

/** Exported for the smoke script's reserve-sizing assertion. */
export const INTRO_STAR_AREA = STAR_AREA;
export const INTRO_SEED_FRACTION = SEED_FRACTION;
export const INTRO_OUTBOUND_MS = CHRONO_OUTBOUND_MS;
