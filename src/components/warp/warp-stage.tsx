"use client";

import { useEffect, useRef } from "react";
import {
  ARRIVAL_MS,
  ASCENT,
  ASCENT_MS,
  ASCENT_OPAQUE_MS,
  EARTH_FADE,
  EARTH_RECEDE,
  FLYBYS,
  FLYBY_DEPTH,
  REENTRY,
  REENTRY_MS,
  REDUCED_MS,
  easeHouse,
  easeIn,
  span,
} from "@/lib/warp/choreography";
import {
  PLANET_KINDS,
  drawEarth,
  drawPlanet,
  drawRocket,
  drawSatellite,
  makeEarthTexture,
} from "@/lib/warp/celestial";
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
type Sat = { x: number; s: number; phase: number; spin: number };

const STAR_AREA = 2600;
const STAR_CAP = 700;
const CLOUD_COUNT = 7;

/** Peak field speed, in px/frame at depth 1. Kept modest: long uniform streaks
 * stop reading as travel and start reading as heavy rain down the screen. */
const TOP_SPEED = 25;
const TRAIL = 1.35;
const TRAIL_CAP = 105;
/** How much of the altitude ramp fits on one screen. Descent only — the climb
 * starts above the atmosphere now and never touches this. */
const RAMP_BAND = 0.42;

/** Low-orbit traffic, as fractions of viewport width. Phases stagger their
 * entrances so they read as scattered rather than as a formation. */
const SATELLITES: Sat[] = [
  { x: 0.22, s: 1.15, phase: 0.0, spin: 0.9 },
  { x: 0.74, s: 0.85, phase: 0.3, spin: -1.3 },
  { x: 0.46, s: 0.6, phase: 0.56, spin: 1.7 },
  { x: 0.88, s: 1.0, phase: 0.78, spin: -0.7 },
];

/** Coming home you pass the outer worlds again, fast and in reverse order.
 * Three is all a 1.5s fall has room for, and they have to be done before
 * Earth swells past about 0.6 of the fall — after that it simply occludes
 * them, and a pass nobody can see is a pass not worth drawing. */
const RETURN_PASSES = [
  { kind: "neptune", at: 0.16, side: 1, close: 0.5, lateral: 0.44 },
  { kind: "uranus", at: 0.34, side: -1, close: 0.42, lateral: 0.5 },
  { kind: "saturn", at: 0.52, side: 1, close: 0.78, lateral: 0.36 },
];

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
 *
 * The climb starts above the atmosphere: the dashboard falls away to uncover an
 * Earth that already fills the frame, black opens around it as we pull back,
 * and then six worlds are passed one at a time. The atmosphere ramp survives
 * only on the way down, where you actually fall through air.
 */
export function WarpStage({ run }: { run: WarpRun }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runRef = useRef(run);
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
    let space: HTMLCanvasElement | null = null;
    const earthTex = makeEarthTexture();

    const night = document.documentElement.classList.contains("dark");
    const ramp = night ? ATMOSPHERE_NIGHT : ATMOSPHERE;
    const groundHex =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim() || (night ? "#272727" : "#fbfbf9");
    const ground = hexToRgb(groundHex.startsWith("#") ? groundHex : night ? "#272727" : "#fbfbf9");

    /** A zero-size viewport at mount produces a zero-size layer, and drawImage
     * throws InvalidStateError on those — taking down the page tree rather than
     * just the sky. The resize listener repairs it once dimensions arrive. */
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

    /** Deep space, plus a brief bleed of the app's own background at the very
     * start so the reveal doesn't hard-cut from a light dashboard to black. */
    function paintBackdrop(seam: number) {
      if (hasSpace()) ctx!.drawImage(space!, 0, 0, width, height);
      else {
        ctx!.fillStyle = DEEP_SPACE;
        ctx!.fillRect(0, 0, width, height);
      }
      if (seam > 0.002) {
        ctx!.fillStyle = `rgba(${ground[0]}, ${ground[1]}, ${ground[2]}, ${seam})`;
        ctx!.fillRect(0, 0, width, height);
      }
    }

    /** Sky sampled as a vertical window over the altitude ramp. Descent only. */
    function paintSky(altitude: number) {
      const g = ctx!.createLinearGradient(0, 0, 0, height);
      const uBottom = 1 - altitude + RAMP_BAND * 0.35;
      const uTop = uBottom - RAMP_BAND;
      for (let i = 0; i <= 6; i++) {
        const f = i / 6;
        const [r, gg, b] = sampleRamp(ramp, uTop + (uBottom - uTop) * f);
        g.addColorStop(f, `rgb(${r}, ${gg}, ${b})`);
      }
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, width, height);

      const mix = clamp01((altitude - 0.7) / 0.3);
      if (mix > 0 && hasSpace()) {
        ctx!.globalAlpha = mix;
        ctx!.drawImage(space!, 0, 0, width, height);
        ctx!.globalAlpha = 1;
      }
    }

    function paintClouds(vis: number, rush: number, dt: number) {
      if (vis <= 0.001) return;
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

    function paintHorizon(a: number, altitude: number) {
      if (a <= 0.002) return;
      ctx!.save();
      ctx!.globalCompositeOperation = "screen";
      ctx!.translate(width * 0.5, height * (1.06 + altitude * 0.22));
      ctx!.scale(1, 0.36);
      const rx = width * (1.15 - altitude * 0.45);
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
        const tail = Math.min(TRAIL_CAP, Math.abs(v) * TRAIL);
        const color = s.gold ? STAR_GOLD : STAR_WHITE;

        if (tail > 2.5) {
          const dir = Math.sign(v);
          const g = ctx!.createLinearGradient(s.x, s.y - tail * dir, s.x, s.y);
          g.addColorStop(0, `rgba(${color}, 0)`);
          g.addColorStop(1, `rgba(${color}, ${a * 0.55})`);
          ctx!.strokeStyle = g;
          ctx!.lineWidth = s.r * 1.1;
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

    /**
     * One world, passed.
     *
     * Distance falls exponentially across the window, so `1/z` — which drives
     * both the radius and how far the world swings off the centre line — hangs
     * almost still in the distance and then arrives all at once. That late
     * rush is the whole difference between a flyby and a slide.
     *
     * `up` mirrors the vertical for the trip home, where worlds come at you
     * from below and leave past the top.
     */
    function paintPass(
      kind: string,
      p: number,
      side: number,
      close: number,
      lateral: number,
      up: boolean,
    ) {
      if (p <= 0 || p >= 1) return;
      // 1/z, normalised: ~0.04 at the far end, 1 at closest approach.
      const k = Math.pow(FLYBY_DEPTH, p) / FLYBY_DEPTH;
      // Travel has to outrun the world's own radius. A body is dropped the
      // moment its window ends, so if it hasn't cleared the frame by then it
      // pops out of existence mid-shot — which is exactly what a 1.1-screen
      // Saturn did on a fixed 1.15-screen travel. Clearing needs
      // (1 - vp + close) screens; the rest is margin.
      const vp = -0.2;
      const travel = 1.5 + close;
      drawPlanet(ctx!, {
        x: width * 0.5 + side * width * lateral * k,
        y: up
          ? height * (1 - vp) - height * travel * k // rises from below, exits past the top
          : height * vp + height * travel * k, // drops from above, exits past the bottom
        r: close * height * k,
        // A world never fades out — it leaves because it is behind you.
        alpha: span(p, [0, 0.12]),
        def: PLANET_KINDS[kind],
      });
    }

    function paintTour(elapsed: number) {
      for (const f of FLYBYS) {
        paintPass(
          f.kind,
          span(elapsed, [f.at - f.lead, f.at + f.trail]),
          f.side,
          f.close,
          f.lateral,
          false,
        );
      }
    }

    function paintReturnPasses(fall: number) {
      for (const f of RETURN_PASSES) {
        paintPass(f.kind, span(fall, [f.at - 0.2, f.at + 0.2]), f.side, f.close, f.lateral, true);
      }
    }

    /** Low-orbit traffic, sliding down past a climber. */
    function paintSatellites(elapsed: number, now: number) {
      const band = span(elapsed, [1150, 2900]);
      if (band <= 0 || band >= 1) return;
      for (const sat of SATELLITES) {
        const p = band * 1.55 - sat.phase;
        if (p <= 0 || p >= 1) continue;
        drawSatellite(ctx!, {
          x: width * sat.x,
          y: -70 + p * (height + 140),
          s: sat.s,
          rot: now * 0.0006 * sat.spin,
          alpha: Math.min(span(p, [0, 0.12]), 1 - span(p, [0.86, 1])),
        });
      }
    }

    /** Another craft, leaving with us and pulling ahead into the dark. */
    function paintRocket(elapsed: number, now: number) {
      const p = span(elapsed, [1250, 2700]);
      if (p <= 0 || p >= 1) return;
      drawRocket(ctx!, {
        x: width * (0.24 + 0.06 * p),
        y: height * (1.05 - 0.9 * easeHouse(p)),
        s: 1.5 - 1.2 * p,
        alpha: Math.min(span(p, [0, 0.1]), 1 - span(p, [0.8, 1])),
        flicker: 0.5 + 0.5 * Math.sin(now * 0.035),
      });
    }

    /**
     * The planet you are leaving.
     *
     * At `e = 0` the disc is 1.9 screens across with its top edge off the top
     * of the frame — it covers every pixel, which is the point. Interpolating
     * the TOP edge rather than the centre is what keeps the limb sliding down
     * into view as it shrinks, instead of the whole thing collapsing inward.
     */
    function paintEarth(e: number, alpha: number) {
      const r = height * (1.5 - 1.38 * e);
      const top = height * (-0.5 + 1.22 * e);
      drawEarth(ctx!, earthTex, {
        cx: width * 0.5,
        cy: top + r,
        r,
        alpha,
        rim: clamp01((e - 0.06) / 0.3),
      });
    }

    function paintIgnition(elapsed: number, origin: { x: number; y: number } | null) {
      if (!origin) return;
      const t = span(elapsed, [0, 620]);
      if (t >= 1) return;
      ctx!.save();
      ctx!.globalCompositeOperation = "screen";
      ctx!.strokeStyle = `rgba(${HORIZON_GOLD}, ${(1 - t) * 0.5})`;
      ctx!.lineWidth = 2 * (1 - t) + 0.5;
      ctx!.beginPath();
      ctx!.arc(origin.x, origin.y, 18 + easeHouse(t) * 320, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.restore();
    }

    /** A soft glow bleeding in from one edge. `reach` is how far it carries —
     * much past a third and it stops reading as a glow and starts reading as
     * the black of space being washed out to grey. */
    function paintWash(alpha: number, color: string, fromTop: boolean, reach = 0.34) {
      if (alpha <= 0.002) return;
      const g = ctx!.createLinearGradient(
        0,
        fromTop ? 0 : height,
        0,
        fromTop ? height * reach : height * (1 - reach),
      );
      g.addColorStop(0, `rgba(${color}, ${alpha})`);
      g.addColorStop(1, `rgba(${color}, 0)`);
      ctx!.save();
      ctx!.globalCompositeOperation = "screen";
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, width, height);
      ctx!.restore();
    }

    /** Vignette closing in over the departure: the sky takes the edges of the
     * frame first and the centre last, so the dashboard stays visible while it
     * falls instead of being cut away. */
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
      const dt = Math.min(3, (now - last) / 16.6667);
      last = now;
      const elapsed = now - state.startedAt;

      ctx!.clearRect(0, 0, width, height);

      if (state.reduced) {
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
        const fall = span(elapsed, REENTRY.fall);
        // Air only shows up in the last third; before that we are still in space.
        const altitude = 1 - easeIn(clamp01((fall - 0.55) / 0.45));
        const e = 1 - easeIn(fall);

        if (altitude > 0.995) paintBackdrop(0);
        else paintSky(altitude);
        paintStars(clamp01(altitude / 0.5), -TOP_SPEED * 1.15 * (1 - easeHouse(fall)), dt);
        paintReturnPasses(fall);
        paintEarth(e, 1 - span(fall, [0.86, 1]));
        paintClouds(clamp01((0.5 - Math.abs(altitude - 0.22)) / 0.3), -34, dt);
        paintHorizon(0.5 * span(fall, [0.72, 1]), altitude);
        paintWash((1 - span(elapsed, REENTRY.retroBurn)) * 0.34, "255, 246, 224", true);
        paintWash(
          0.5 * Math.sin(Math.PI * span(elapsed, [REENTRY.fall[1] * 0.45, REENTRY.judder[0] + 140])),
          REENTRY_BURN,
          false,
          0.55,
        );
        canvas!.style.opacity = String(1 - span(elapsed, [REENTRY.judder[0], REENTRY_MS - 120]));
        raf = requestAnimationFrame(frame);
        return;
      }

      // ── Ascent, cruise, arrival ───────────────────────────────────────────
      const climbing = state.phase === "ascending";
      const decelerating = state.phase === "arriving" && state.arrivingAt !== null;
      const sinceArrive = decelerating ? now - state.arrivingAt! : 0;
      // Cruise and arrival hold at the end of the flight plan.
      const t = climbing ? elapsed : ASCENT_MS;

      let speed: number;
      if (decelerating) {
        speed = 1.2 + (TOP_SPEED - 1.2) * (1 - easeHouse(span(sinceArrive, [0, ARRIVAL_MS * 0.8])));
      } else {
        // Held low while Earth still fills the frame — streaks over a planet
        // that is right there read as rain on a window, not as travel.
        speed = 3 + (TOP_SPEED - 3) * easeIn(span(t, [ASCENT.recede[0], ASCENT_MS]));
      }

      const earth = easeHouse(span(t, EARTH_RECEDE));

      paintBackdrop(climbing ? 1 - span(elapsed, [0, 520]) : 0);
      paintStars(clamp01(span(t, [ASCENT.recede[0], ASCENT.recede[1]])), speed, dt);
      paintEarth(earth, 1 - span(t, EARTH_FADE));
      paintSatellites(t, now);
      paintRocket(t, now);
      paintTour(t);

      if (climbing) {
        paintWash(
          0.11 * Math.sin(Math.PI * span(elapsed, [ASCENT.vacuum[0], ASCENT_MS + 150])),
          "255, 248, 232",
          false,
          0.28,
        );
        paintIgnition(elapsed, state.origin);
        applyReveal(span(elapsed, [80, ASCENT_OPAQUE_MS]));
      }

      canvas!.style.opacity = decelerating
        ? String(1 - span(sinceArrive, [ARRIVAL_MS * 0.35, ARRIVAL_MS]))
        : "1";

      raf = requestAnimationFrame(frame);
    }

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
      className="fixed inset-0 z-[9999] h-full w-full"
    />
  );
}
