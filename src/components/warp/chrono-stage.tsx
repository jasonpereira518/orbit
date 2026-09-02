"use client";

import { useEffect, useRef } from "react";
import {
  CHRONO_ARRIVING_MS,
  CHRONO_IN,
  CHRONO_IN_COVER,
  CHRONO_OPAQUE_MS,
  CHRONO_OUT,
  CRUISE_BURSTS,
  CRUISE_RESERVE_FRACTION,
  IGNITION_FRACTIONS,
  POLE,
  burstForRadiusRank,
  chronoFrame,
  type ChronoFrame,
  type ChronoPhase,
} from "@/lib/warp/chrono";
import { REDUCED_MS, easeFade, span } from "@/lib/warp/choreography";
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
/** How much of the field is already there when the exposure opens: a few
 *  spots near the pole. The rest ignite as the orbit grows and spreads
 *  outward to fill the frame — the whole point of the journey. */
const SEED_FRACTION = 0.12;
/** Keeps the innermost radii empty so the pole never becomes a bullseye
 *  competing with the arriving page. */
const CORE = 0.07;
/** A backgrounded tab returns with an enormous delta; without this the field
 *  would snap through a whole revolution in one frame. */
const MAX_DT = 0.05;
/** How fast an ignition flash decays, per second. */
const FLASH_DECAY = 3.2;
/**
 * Where a reserve star sits in the growth order. Just under 1 — they are the
 * newest things in the sky — but strictly below it, because `born < alive` is
 * the lit gate and `alive` is exactly 1 for the whole outbound leg.
 */
const RESERVE_BORN = 0.99;
/**
 * Coverage at which the canvas starts swallowing clicks.
 *
 * The stage is `position: fixed` over the whole viewport, but the DESTINATION
 * page is not the one the `[data-warp-craft]` pointer-events rule reaches —
 * that rule only disables the origin's app shell, and the destination mounts
 * in a different layout entirely. On /pricing that was cosmetic. /upgrade has
 * checkout buttons under the cover, and a blind click there starts a Stripe
 * session the visitor never saw. Half-hidden or more is not a click anyone
 * meant to make.
 */
const COVER_BLOCKS_CLICKS = 0.5;

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
    /** Radius of the corner furthest from the pole; the field scales with it. */
    let maxR = 0;
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

    /** The beat math for right now. */
    function currentFrame() {
      const r = runRef.current;
      const now = performance.now();
      return chronoFrame(
        chronoPhaseOf(r.phase),
        now - r.startedAt,
        r.arrivingAt === null ? 0 : now - r.arrivingAt,
      );
    }

    /**
     * Whether a star with this burst and birth order is alight in frame `f`.
     *
     * Shared by the draw loop and the field builder on purpose: a field built
     * mid-run must agree with the very next frame about what is already lit,
     * or every one of those stars takes the ignition branch at once.
     */
    function isLit(f: ChronoFrame, burst: number, born: number) {
      return burst >= 0 && f.bursts > burst && born < f.alive;
    }

    function newStar(burst: number, born: number, f: ChronoFrame): Star {
      return {
        // sqrt keeps the areal density even; CORE holds the knot open.
        radius: maxR * (CORE + (1 - CORE) * Math.sqrt(Math.random())),
        angle: Math.random() * Math.PI * 2,
        r: Math.random() * 1.15 + 0.35,
        gold: Math.random() < 0.05,
        burst,
        flash: 0,
        // Seeded from what is already true rather than from "nothing has ever
        // been lit". The stage REMOUNTS for the inbound run, where seven
        // bursts have already fired — without this, ~88% of the field would
        // take the `!s.ignited` branch on the first frame of the rewind and
        // the sky would flare gold at the exact moment stars should be going
        // out. The flare must only ever fire on a genuine unlit -> lit change.
        ignited: isLit(f, burst, born),
        born,
      };
    }

    function buildField() {
      const count = Math.min(Math.floor((width * height) / STAR_AREA), STAR_CAP);
      const seeds = Math.floor(count * SEED_FRACTION);
      const f = currentFrame();

      // Build the field, then sort by ascending radius so growth spreads
      // OUTWARD from the pole: the innermost `seeds` stars are the always-
      // present spots, and every star beyond them ignites in a burst keyed to
      // how far out it sits, filling the frame from the centre outward.
      const field = Array.from({ length: count }, () => newStar(-1, 0, f));
      field.sort((a, b) => a.radius - b.radius);
      stars = field.map((s, i) => {
        const grown = i >= seeds;
        const rank = grown ? (i - seeds) / Math.max(1, count - seeds) : 0;
        const burst = grown ? burstForRadiusRank(rank) : -1;
        return { ...s, burst, born: rank, ignited: isLit(f, burst, rank) };
      });

      // The reserve: stars only a cruise hold can reach. Their burst indices
      // begin where the scripted seven end, and `chronoFrame` only counts past
      // seven while holding — so on a fast route not one of them ever appears,
      // and during a hold the sky keeps filling instead of becoming a loop.
      // Radii are drawn from the whole range rather than continuing the
      // outward march: this is the sky filling in during a wait, not more of
      // the designed seven-burst spread.
      const reserve = Math.floor(count * CRUISE_RESERVE_FRACTION);
      for (let i = 0; i < reserve; i += 1) {
        const burst =
          IGNITION_FRACTIONS.length + Math.floor((i / reserve) * CRUISE_BURSTS);
        stars.push(newStar(burst, RESERVE_BORN, f));
      }
    }

    function resize() {
      const prevTrail = trail;
      const prevMaxR = maxR;

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
      // Far enough out to cover the corner furthest from the pole, or arcs
      // would stop short of the frame edge.
      maxR = Math.max(
        Math.hypot(poleX, poleY),
        Math.hypot(width - poleX, poleY),
        Math.hypot(poleX, height - poleY),
        Math.hypot(width - poleX, height - poleY),
      );

      // The trail layer is never cleared — that accumulation IS the exposure —
      // so it is its own canvas, composited over the space base each frame.
      const t = document.createElement("canvas");
      t.width = Math.floor(width * dpr);
      t.height = Math.floor(height * dpr);
      const tctx = t.getContext("2d");
      if (!tctx) return;
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Carry the accumulated exposure over rather than starting blank: a
      // resize mid-run would otherwise wipe every arc in a single frame, which
      // is a harder cut than anything else in the journey. Stretched rather
      // than re-projected — the pole is a viewport fraction, so the mapping is
      // close, and the shutter erases the residue within a few hundred ms.
      if (prevTrail) tctx.drawImage(prevTrail, 0, 0, width, height);
      trail = t;
      trailCtx = tctx;

      if (stars.length > 0) {
        // Keep the field across a resize. Rebuilding it re-randomises every
        // position mid-arc, which reads as the sky being swapped out; scaling
        // the radii holds the composition and every star's history with it.
        // Density is left at the count the field was built for — a transition
        // is 2s long and nobody resizes through one twice.
        const k = prevMaxR > 0 ? maxR / prevMaxR : 1;
        for (const s of stars) s.radius *= k;
        return;
      }
      buildField();
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
      const elapsed = now - r.startedAt;
      // `skip()` has brought the route swap forward. The inbound cover is
      // deliberately down until CHRONO_IN_COVER opens so the exit can be seen,
      // which means a skip inside that window would swap the route through a
      // clear canvas. Pin it, and stay pinned for the rest of the run: the
      // stage unmounts SKIP_COVER_MS later, and un-pinning before then would
      // reopen the very frame this exists to close.
      //
      // Above the reduced branch on purpose — a pinned run must be opaque
      // whatever else is true — and that is precisely why `skip()` never sets
      // the flag on a reduced run: a hard cut to opaque is what that path
      // exists to avoid. The two halves have to be read together.
      if (r.covered) return 1;
      if (r.reduced) {
        // Exactly the liftoff stage's reduced path, and for its reason: a
        // full-viewport cut to an opaque deep-space canvas and a cut back out
        // is a bigger luminance jump than the animation this visitor opted out
        // of. The stage fades in, the route swaps, the stage fades out.
        const fadeIn = span(elapsed, [0, REDUCED_MS]);
        const out =
          r.phase === "arriving" && r.arrivingAt !== null
            ? 1 - span(now - r.arrivingAt, [0, REDUCED_MS])
            : r.phase === "inbound" || r.phase === "landing"
              ? 1 - span(elapsed, [0, REDUCED_MS])
              : 1;
        return Math.min(fadeIn, out);
      }
      if (r.phase === "arriving") {
        const since = r.arrivingAt === null ? 0 : now - r.arrivingAt;
        // Hold through the collapse (the first CHRONO_OPAQUE_MS of the
        // arriving window), then hand off over the remainder.
        return 1 - easeFade(span(since, [CHRONO_OPAQUE_MS, CHRONO_ARRIVING_MS]));
      }
      if (r.phase === "inbound" || r.phase === "landing") {
        // UP behind the departing panels, then down again over the landing
        // window. Mounting at full cover would put the entire reverse-staggered
        // exit behind an opaque canvas — and that exit, the panels lifting and
        // flying out to either side, is the shot the late `CHRONO_IN.push`
        // exists to buy time for. The two windows are far apart, so `min`
        // leaves a flat plateau between them rather than clipping either ramp.
        return Math.min(
          easeFade(span(elapsed, CHRONO_IN_COVER)),
          1 - easeFade(span(elapsed, CHRONO_IN.landing)),
        );
      }
      return easeFade(span(elapsed, CHRONO_OUT.shutter));
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
            if (!isLit(f, s.burst, s.born)) {
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

          // Decay unconditionally, before the off-screen cull below.
          // `flash` has no dependency on x/y, and a star that ignites while
          // off-screen still needs to decay in real time — otherwise it
          // freezes at full flare and swims into view later, mid-orbit,
          // unrelated to any burst boundary. Don't move this back down next
          // to the drawing code.
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

        // `lighter` so the trails add light over the nebulae instead of
        // punching a hole through them.
        ctx!.globalCompositeOperation = "lighter";
        ctx!.drawImage(trail, 0, 0, width, height);
        ctx!.globalCompositeOperation = "source-over";
      }

      const cover = coverage(now);
      canvas!.style.opacity = String(cover);
      // See COVER_BLOCKS_CLICKS: the page under the cover stays fully
      // interactive otherwise, and on /upgrade that page has checkout buttons.
      canvas!.style.pointerEvents = cover >= COVER_BLOCKS_CLICKS ? "auto" : "none";
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
    // No `pointer-events-none` class: the frame loop owns that property (see
    // COVER_BLOCKS_CLICKS), and a class setting it too would read as the
    // authority while being silently overridden by the inline style — an
    // invitation to "tidy away" the per-frame assignment and hand /upgrade's
    // live checkout buttons back to a blind click under an opaque cover. The
    // initial value lives in the same style object the loop writes to.
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 z-[100] h-full w-full"
      style={{ opacity: 0, pointerEvents: "none" }}
    />
  );
}
