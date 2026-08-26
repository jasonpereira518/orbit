"use client";

import { useEffect, useRef } from "react";
import {
  ARRIVAL_MS,
  ASCENT,
  ASCENT_MS,
  ASCENT_OPAQUE_MS,
  REENTRY,
  REENTRY_MS,
  REDUCED_MS,
  easeHouse,
  easeIn,
  span,
} from "@/lib/warp/choreography";
import {
  ATMOSPHERE,
  ATMOSPHERE_NIGHT,
  DEEP_SPACE,
  HORIZON_GOLD,
  REENTRY_BURN,
  STAR_GOLD,
  STAR_WHITE,
  hexToRgb,
  paintSpace,
  sampleRamp,
} from "@/lib/sky-palette";
import type { WarpRun } from "@/components/warp/warp-provider";

type Star = { x: number; y: number; depth: number; r: number; gold: boolean };
type Cloud = { x: number; y: number; r: number; a: number; speed: number };

/** One star per this many px2 of viewport, capped for ultrawide displays. */
const STAR_AREA = 2200;
const STAR_CAP = 900;
const CLOUD_COUNT = 6;

/** Peak field speed, in px/frame at depth 1. Depth divides it, so the nearest
 * stars run ~3x this and the farthest barely drift. */
const TOP_SPEED = 34;
/** How much of the altitude ramp fits on one screen. Smaller = the sky changes
 * faster as you climb; larger = a longer, softer gradient. */
const RAMP_BAND = 0.42;

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

/**
 * The journey, painted.
 *
 * One canvas, one rAF loop, every beat derived from elapsed time rather than
 * from React state — the provider re-renders at most five times per run, which
 * is nowhere near enough to drive an animation. `run` is read through a ref so
 * a phase change never restarts the loop mid-flight.
 */
export function WarpStage({ run }: { run: WarpRun }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runRef = useRef(run);
  // The loop reads phase through a ref so a transition never restarts it
  // mid-flight. Synced after commit rather than during render; the loop picks
  // the new value up on its next frame, which is 16ms it will never notice.
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
    let stars: Star[] = [];
    let clouds: Cloud[] = [];
    // The deep-space base (gradient + nebulae) is several full-screen radial
    // fills — far too expensive per frame, so it is rendered once per resize
    // and blitted. It is also the exact image the real starfield paints, which
    // is what makes the handoff at the end of the ascent invisible.
    let space: HTMLCanvasElement | null = null;

    // Read once: the ramp has to start from wherever the user actually is, or
    // a dark-mode dashboard washes out to a bright blue sky and reads as a bug.
    const night = document.documentElement.classList.contains("dark");
    const ramp = night ? ATMOSPHERE_NIGHT : ATMOSPHERE;
    const groundHex =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim() || (night ? "#272727" : "#fbfbf9");
    const ground = hexToRgb(groundHex.startsWith("#") ? groundHex : night ? "#272727" : "#fbfbf9");

    /** A zero-size viewport at mount (a hidden tab being restored, a prerender)
     * produces a zero-size layer, and drawImage throws InvalidStateError on
     * those — which would take down the page tree rather than just the sky.
     * The resize listener repairs the layer once real dimensions arrive. */
    function hasSpace() {
      return space !== null && space.width > 0 && space.height > 0;
    }

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

      const count = Math.min(Math.floor((width * height) / STAR_AREA), STAR_CAP);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        // Biased toward the far field so most stars drift and only a few tear
        // past — an evenly distributed depth reads as noise, not as parallax.
        depth: 0.35 + Math.pow(Math.random(), 0.6) * 1.5,
        r: Math.random() * 1.3 + 0.35,
        gold: Math.random() < 0.05,
      }));

      clouds = Array.from({ length: CLOUD_COUNT }, () => ({
        x: Math.random() * width,
        y: Math.random() * height * 1.4 - height * 0.2,
        r: (0.18 + Math.random() * 0.3) * width,
        a: 0.1 + Math.random() * 0.16,
        speed: 0.6 + Math.random() * 0.9,
      }));
    }

    /** Sky, sampled as a vertical window over the altitude ramp. */
    function paintSky(altitude: number) {
      const g = ctx!.createLinearGradient(0, 0, 0, height);
      // u runs 0 (vacuum) -> 1 (ground). Climbing slides the window up the ramp.
      const uBottom = 1 - altitude + RAMP_BAND * 0.35;
      const uTop = uBottom - RAMP_BAND;
      for (let i = 0; i <= 6; i++) {
        const f = i / 6;
        const [r, gg, b] = sampleRamp(ramp, uTop + (uBottom - uTop) * f);
        g.addColorStop(f, `rgb(${r}, ${gg}, ${b})`);
      }
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, width, height);

      // Right at the ground, blend toward the app's own background so the very
      // first frames of the climb leave the dashboard rather than replacing it.
      const seam = 1 - clamp01(altitude / 0.16);
      if (seam > 0) {
        ctx!.fillStyle = `rgba(${ground[0]}, ${ground[1]}, ${ground[2]}, ${seam * 0.9})`;
        ctx!.fillRect(0, 0, width, height);
      }

      // Cross-fade into the real starfield's exact background as we reach vacuum.
      const mix = clamp01((altitude - 0.7) / 0.3);
      if (mix > 0 && hasSpace()) {
        ctx!.globalAlpha = mix;
        ctx!.drawImage(space!, 0, 0, width, height);
        ctx!.globalAlpha = 1;
      }
    }

    function paintClouds(altitude: number, dt: number, falling: boolean) {
      // Cloud deck lives low; above it there is nothing to see.
      const vis = clamp01(1 - altitude / 0.55) * clamp01(altitude / 0.06);
      if (vis <= 0.001) return;
      const rush = (falling ? -1 : 1) * (6 + 46 * easeIn(clamp01(altitude / 0.6)));
      for (const c of clouds) {
        c.y += rush * c.speed * dt;
        if (c.y - c.r > height + c.r) c.y = -c.r * 1.5;
        if (c.y + c.r < -c.r * 1.5) c.y = height + c.r;
        const grad = ctx!.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
        const tint = night ? "168, 186, 214" : "255, 255, 255";
        grad.addColorStop(0, `rgba(${tint}, ${c.a * vis})`);
        grad.addColorStop(0.55, `rgba(${tint}, ${c.a * vis * 0.4})`);
        grad.addColorStop(1, `rgba(${tint}, 0)`);
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.ellipse(c.x, c.y, c.r, c.r * 0.42, 0, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    /** The planet falling away below — a wide, soft limb rather than a literal
     * horizon line, which at this scale would read as a stripe. */
    function paintHorizon(altitude: number) {
      const a = 0.6 * clamp01((altitude - 0.2) / 0.3) * (1 - clamp01((altitude - 0.72) / 0.28));
      if (a <= 0.002) return;
      const cx = width * 0.5;
      const cy = height * (1.06 + altitude * 0.22);
      const rx = width * (1.15 - altitude * 0.45);
      ctx!.save();
      ctx!.globalCompositeOperation = "screen";
      ctx!.translate(cx, cy);
      ctx!.scale(1, 0.36);
      const g = ctx!.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgba(${HORIZON_GOLD}, ${a * 0.55})`);
      g.addColorStop(0.45, `rgba(${HORIZON_GOLD}, ${a * 0.22})`);
      g.addColorStop(1, `rgba(${HORIZON_GOLD}, 0)`);
      ctx!.fillStyle = g;
      ctx!.beginPath();
      ctx!.arc(0, 0, rx, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.restore();
    }

    /**
     * The field. Motion is vertical — we are climbing, not jumping to
     * lightspeed — with a slight outward drift from a vanishing point above
     * frame, which is what a wide lens does to a sky you are rising through.
     */
    function paintStars(alpha: number, speed: number, dt: number) {
      if (alpha <= 0.002) return;
      const vpx = width * 0.5;
      for (const s of stars) {
        const v = (speed / s.depth) * dt;
        s.y += v;
        s.x += ((s.x - vpx) / width) * Math.abs(v) * 0.16;

        if (s.y > height + 40) {
          s.y = -20;
          s.x = Math.random() * width;
        } else if (s.y < -40) {
          s.y = height + 20;
          s.x = Math.random() * width;
        }
        if (s.x < -30 || s.x > width + 30) s.x = Math.random() * width;

        const a = alpha * (0.45 + 0.55 * clamp01(1.6 - s.depth * 0.7));
        const tail = Math.min(190, Math.abs(v) * 2.4);
        const color = s.gold ? STAR_GOLD : STAR_WHITE;

        if (tail > 2.5) {
          const dir = Math.sign(v);
          const g = ctx!.createLinearGradient(s.x, s.y - tail * dir, s.x, s.y);
          g.addColorStop(0, `rgba(${color}, 0)`);
          g.addColorStop(1, `rgba(${color}, ${a})`);
          ctx!.strokeStyle = g;
          ctx!.lineWidth = s.r * 1.5;
          ctx!.lineCap = "round";
          ctx!.beginPath();
          ctx!.moveTo(s.x, s.y - tail * dir);
          ctx!.lineTo(s.x, s.y);
          ctx!.stroke();
        } else {
          ctx!.fillStyle = `rgba(${color}, ${a})`;
          ctx!.beginPath();
          ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    /** Expanding ring from the button that was actually pressed, so the launch
     * visibly originates from the user's own click rather than from nowhere. */
    function paintIgnition(elapsed: number, origin: { x: number; y: number } | null) {
      if (!origin) return;
      const t = span(elapsed, [0, 460]);
      if (t >= 1) return;
      const r = 18 + easeHouse(t) * 260;
      const a = (1 - t) * 0.5;
      ctx!.save();
      ctx!.globalCompositeOperation = "screen";
      ctx!.strokeStyle = `rgba(${HORIZON_GOLD}, ${a})`;
      ctx!.lineWidth = 2 * (1 - t) + 0.5;
      ctx!.beginPath();
      ctx!.arc(origin.x, origin.y, r, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.restore();
    }

    function paintWash(alpha: number, color: string, fromTop: boolean) {
      if (alpha <= 0.002) return;
      const g = ctx!.createLinearGradient(0, fromTop ? 0 : height, 0, fromTop ? height * 0.7 : height * 0.3);
      g.addColorStop(0, `rgba(${color}, ${alpha})`);
      g.addColorStop(1, `rgba(${color}, 0)`);
      ctx!.save();
      ctx!.globalCompositeOperation = "screen";
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, width, height);
      ctx!.restore();
    }

    /** Vignette that closes in over the first stretch of the climb: the sky
     * takes the edges of the frame first and the centre last, so the dashboard
     * stays visible while it falls instead of being cut to black. */
    function applyReveal(reveal: number) {
      if (reveal >= 1) return;
      const cx = width * 0.5;
      const cy = height * 0.52;
      const g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(width, height) * 0.6);
      g.addColorStop(0, `rgba(0, 0, 0, ${reveal})`);
      g.addColorStop(0.5, `rgba(0, 0, 0, ${reveal + (1 - reveal) * 0.4})`);
      g.addColorStop(1, "rgba(0, 0, 0, 1)");
      ctx!.globalCompositeOperation = "destination-in";
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, width, height);
      ctx!.globalCompositeOperation = "source-over";
    }

    let last = performance.now();

    function frame(now: number) {
      const state = runRef.current;
      // Normalised to 60fps so speeds stay physical on 120Hz displays and
      // degrade gracefully if a frame is dropped.
      const dt = Math.min(3, (now - last) / 16.6667);
      last = now;
      const elapsed = now - state.startedAt;

      ctx!.clearRect(0, 0, width, height);

      if (state.reduced) {
        // No motion at all: a calm hold on the destination's own background.
        // It still covers the route swap, so reduced-motion users get the
        // benefit of the transition (no skeleton flash) without the journey.
        if (hasSpace()) ctx!.drawImage(space!, 0, 0, width, height);
        else {
          ctx!.fillStyle = DEEP_SPACE;
          ctx!.fillRect(0, 0, width, height);
        }
        const fadeIn = span(elapsed, [0, REDUCED_MS]);
        const out =
          state.phase === "arriving" && state.arrivingAt !== null
            ? 1 - span(now - state.arrivingAt, [0, REDUCED_MS])
            : state.phase === "descending" || state.phase === "landing"
              ? 1 - span(elapsed, [0, REDUCED_MS])
              : 1;
        canvas!.style.opacity = String(Math.min(fadeIn, out));
        raf = requestAnimationFrame(frame);
        return;
      }

      if (state.phase === "descending" || state.phase === "landing") {
        // Falling: the ramp runs backwards, roughly 2.5x the pace of the climb.
        const fall = span(elapsed, REENTRY.fall);
        const altitude = 1 - easeIn(fall);
        const speed = -TOP_SPEED * 1.15 * (1 - easeHouse(fall));

        paintSky(altitude);
        paintClouds(altitude, dt, true);
        paintStars(clamp01(altitude / 0.5), speed, dt);
        paintHorizon(altitude);
        // Retro burn overhead, then the heat shield glowing beneath us.
        paintWash((1 - span(elapsed, REENTRY.retroBurn)) * 0.34, "255, 246, 224", true);
        paintWash(
          0.5 * Math.sin(Math.PI * span(elapsed, [60, REENTRY.judder[0] + 120])),
          REENTRY_BURN,
          false,
        );
        canvas!.style.opacity = String(1 - span(elapsed, [REENTRY.judder[0], REENTRY_MS - 60]));
        raf = requestAnimationFrame(frame);
        return;
      }

      // ── Ascent, cruise, arrival ───────────────────────────────────────────
      const climbing = state.phase === "ascending";
      const decelerating = state.phase === "arriving" && state.arrivingAt !== null;
      const sinceArrive = decelerating ? now - state.arrivingAt! : 0;

      const altitude = climbing
        ? Math.pow(clamp01(span(elapsed, [ASCENT.ignition[1], ASCENT.vacuum[0] + 250])), 1.45)
        : 1;

      let speed: number;
      if (climbing) {
        speed = 2 + (TOP_SPEED - 2) * easeIn(clamp01(span(elapsed, [ASCENT.liftoff[0], ASCENT_MS])));
      } else if (decelerating) {
        // Streaks contract back to points, and the field is left drifting at
        // the same lazy pace the real starfield holds.
        speed = 1.2 + (TOP_SPEED - 1.2) * (1 - easeHouse(span(sinceArrive, [0, ARRIVAL_MS * 0.8])));
      } else {
        speed = TOP_SPEED; // cruise
      }

      paintSky(altitude);
      paintClouds(altitude, dt, false);
      paintStars(clamp01((altitude - 0.3) / 0.35), speed, dt);
      paintHorizon(altitude);

      // A single bloom as we punch out of the atmosphere.
      if (climbing) {
        paintWash(
          0.22 * Math.sin(Math.PI * span(elapsed, [ASCENT.vacuum[0], ASCENT_MS + 120])),
          "255, 248, 232",
          false,
        );
        paintIgnition(elapsed, state.origin);
        applyReveal(span(elapsed, [60, ASCENT_OPAQUE_MS]));
      }

      canvas!.style.opacity = decelerating
        ? String(1 - span(sinceArrive, [ARRIVAL_MS * 0.35, ARRIVAL_MS]))
        : "1";

      raf = requestAnimationFrame(frame);
    }

    // Listener first, so if the viewport is zero-sized at mount the resize
    // event that gives it real dimensions can still repair the field.
    window.addEventListener("resize", resize);
    resize();
    raf = requestAnimationFrame(frame);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // Above every other layer in the app (the ask bar sits at z-50, view
      // transition groups at 60). This is a full-screen takeover, and it
      // swallows stray clicks aimed at the page it is covering.
      className="fixed inset-0 z-[9999] h-full w-full"
    />
  );
}
