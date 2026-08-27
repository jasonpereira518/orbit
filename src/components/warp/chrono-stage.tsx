"use client";

import { useEffect, useRef } from "react";
import {
  CHRONO_IN,
  CHRONO_OUT,
  IGNITION_FRACTIONS,
  POLE,
  chronoFrame,
  type ChronoPhase,
} from "@/lib/warp/chrono";
import { span } from "@/lib/warp/choreography";
import { DEEP_SPACE, STAR_GOLD, STAR_WHITE, paintSpace } from "@/lib/sky-palette";
import type { WarpRun } from "@/components/warp/warp-provider";

type Star = {
  /** Distance from the pole, in px. Fixed — stars only ever rotate. */
  radius: number;
  /** Current angle, radians. Advanced by omega each frame. */
  angle: number;
  r: number;
  gold: boolean;
  /**
   * Which ignition burst lights this star, or -1 for one that was always
   * there. A star that ignites mid-run starts accumulating trail from where it
   * appeared, so its arc is visibly shorter than its neighbours' — new
   * contacts read as younger stars with no extra machinery.
   */
  burst: number;
  /** 0..1 when the star has just ignited, decaying to nothing. */
  flash: number;
  /** Whether this star's ignition flare has already been fired. Tracked
   *  explicitly because `flash` decays back to 0, and a decayed flash is
   *  indistinguishable from one that never fired. */
  ignited: boolean;
  /** Position in the growth order, 0..1. On the way home the field thins from
   *  the newest backwards. */
  born: number;
};

/** One star per this many px² of viewport, capped for ultrawide displays. */
const STAR_AREA = 2400;
const STAR_CAP = 1100;
/** How much of the field is already there when the exposure opens. The rest
 *  ignite as the orbit grows — the whole point of the journey. */
const SEED_FRACTION = 0.42;
/** Keeps the innermost radii empty so the pole never becomes a bullseye
 *  competing with the arriving page. */
const CORE = 0.07;
/** A backgrounded tab returns with an enormous delta; without this the field
 *  would snap through a whole revolution in one frame. */
const MAX_DT = 0.05;
/** How fast an ignition flash decays, per second. */
const FLASH_DECAY = 3.2;

/** The provider's phases, narrowed to the ones the beat math knows. */
function chronoPhaseOf(phase: WarpRun["phase"]): ChronoPhase {
  if (phase === "cruise") return "cruise";
  if (phase === "arriving") return "arriving";
  // "landing" is the tail of the return arc; the math treats it as one arc.
  if (phase === "inbound" || phase === "landing") return "inbound";
  return "outbound";
}

/**
 * The time warp, painted.
 *
 * One canvas, one rAF loop, every beat derived from elapsed time rather than
 * from React state — the provider re-renders at most five times per run, which
 * is nowhere near enough to drive an animation. `run` is read through a ref so
 * a phase change never restarts the loop mid-flight.
 *
 * This file owns two layers: the deep-space base, painted once per resize and
 * blitted (it is the exact image the real starfield paints, which is what makes
 * the handoff at the end invisible), and the trail layer above it.
 */
export function ChronoStage({ run }: { run: WarpRun }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runRef = useRef(run);
  // Synced after commit rather than during render; the loop picks the new
  // value up on its next frame, which is 16ms it will never notice.
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let space: HTMLCanvasElement | null = null;
    let trail: HTMLCanvasElement | null = null;
    let trailCtx: CanvasRenderingContext2D | null = null;
    let stars: Star[] = [];
    let poleX = 0;
    let poleY = 0;
    let last = 0;

    function paintSpaceLayer() {
      const off = document.createElement("canvas");
      off.width = Math.floor(width * dpr);
      off.height = Math.floor(height * dpr);
      const bctx = off.getContext("2d");
      if (!bctx) return;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpace(bctx, width, height);
      space = off;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintSpaceLayer();

      poleX = width * POLE.x;
      poleY = height * POLE.y;

      // The trail layer is never cleared — that accumulation IS the exposure —
      // so it is its own canvas, composited over the space base each frame.
      const t = document.createElement("canvas");
      t.width = Math.floor(width * dpr);
      t.height = Math.floor(height * dpr);
      const tctx = t.getContext("2d");
      if (!tctx) return;
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      trail = t;
      trailCtx = tctx;

      // Far enough out to cover the corner furthest from the pole, or arcs
      // would stop short of the frame edge.
      const maxR = Math.max(
        Math.hypot(poleX, poleY),
        Math.hypot(width - poleX, poleY),
        Math.hypot(poleX, height - poleY),
        Math.hypot(width - poleX, height - poleY),
      );

      const count = Math.min(Math.floor((width * height) / STAR_AREA), STAR_CAP);
      const seeds = Math.floor(count * SEED_FRACTION);
      stars = Array.from({ length: count }, (_, i) => {
        const grown = i >= seeds;
        const rank = grown ? (i - seeds) / Math.max(1, count - seeds) : 0;
        return {
          // sqrt keeps the areal density even; CORE holds the knot open.
          radius: maxR * (CORE + (1 - CORE) * Math.sqrt(Math.random())),
          angle: Math.random() * Math.PI * 2,
          r: Math.random() * 1.15 + 0.35,
          gold: Math.random() < 0.05,
          burst: grown
            ? Math.min(
                IGNITION_FRACTIONS.length - 1,
                Math.floor(rank * IGNITION_FRACTIONS.length),
              )
            : -1,
          flash: 0,
          ignited: false,
          born: rank,
        };
      });
    }

    /**
     * How much of the frame the stage covers, 0 to 1.
     *
     * Opening: the shutter window, which is also when the route swap hides
     * behind it. Closing: the arriving window, cross-fading into the real
     * starfield underneath, and the landing window on the way home, where the
     * room lights come back up.
     */
    function coverage(now: number) {
      const r = runRef.current;
      if (r.reduced) return 1;
      const elapsed = now - r.startedAt;
      if (r.phase === "arriving") {
        const since = r.arrivingAt === null ? 0 : now - r.arrivingAt;
        // Hold through the collapse, then hand off.
        return 1 - span(since, [380, 620]);
      }
      if (r.phase === "inbound" || r.phase === "landing") {
        const [from, to] = CHRONO_IN.landing;
        return 1 - span(elapsed, [from, to]);
      }
      return span(elapsed, CHRONO_OUT.shutter);
    }

    function frame() {
      const now = performance.now();
      const r = runRef.current;
      const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_DT);
      last = now;

      ctx!.clearRect(0, 0, width, height);
      ctx!.fillStyle = DEEP_SPACE;
      ctx!.fillRect(0, 0, width, height);
      if (space) ctx!.drawImage(space, 0, 0, width, height);

      // Reduced motion gets the sky and nothing else: no spin, no trails.
      if (!r.reduced && trail && trailCtx) {
        const elapsed = now - r.startedAt;
        const since = r.arrivingAt === null ? 0 : now - r.arrivingAt;
        const f = chronoFrame(chronoPhaseOf(r.phase), elapsed, since);

        // The shutter. Erasing a fraction of the layer leaves the rest as
        // trail; a low alpha leaves long arcs, 1 leaves bare points.
        trailCtx.globalCompositeOperation = "destination-out";
        trailCtx.fillStyle = `rgba(0,0,0,${f.alpha})`;
        trailCtx.fillRect(0, 0, width, height);
        trailCtx.globalCompositeOperation = "source-over";

        const step = f.omega * dt;
        for (const s of stars) {
          s.angle += step;

          if (s.burst >= 0) {
            const lit = f.bursts > s.burst && s.born < f.alive;
            if (!lit) {
              s.ignited = false;
              s.flash = 0;
              continue;
            }
            // Flare once, on the frame it comes alight — not every time the
            // flare finishes decaying.
            if (!s.ignited) {
              s.ignited = true;
              s.flash = 1;
            }
          }

          const x = poleX + Math.cos(s.angle) * s.radius;
          const y = poleY + Math.sin(s.angle) * s.radius;
          if (x < -8 || x > width + 8 || y < -8 || y > height + 8) continue;

          const flare = s.flash;
          if (flare > 0) s.flash = Math.max(0, flare - dt * FLASH_DECAY);

          const rgb = s.gold || flare > 0.15 ? STAR_GOLD : STAR_WHITE;
          trailCtx.fillStyle = `rgba(${rgb},${0.55 + flare * 0.45})`;
          trailCtx.beginPath();
          trailCtx.arc(x, y, s.r * (1 + flare * 2.2), 0, Math.PI * 2);
          trailCtx.fill();
        }

        // `lighter` so the trails add light over the nebulae instead of
        // punching a hole through them.
        ctx!.globalCompositeOperation = "lighter";
        ctx!.drawImage(trail, 0, 0, width, height);
        ctx!.globalCompositeOperation = "source-over";
      }

      canvas!.style.opacity = String(coverage(now));
      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100] h-full w-full"
      style={{ opacity: 0 }}
    />
  );
}
