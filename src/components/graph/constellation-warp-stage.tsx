"use client";

import { useEffect, useRef } from "react";
import {
  INTRO_RESERVE_FRACTION,
  INTRO_WARP_SPEED,
  introCoverage,
  introFrame,
  introPhase,
  introThrottle,
} from "@/lib/graph/intro-choreography";
import type { IntroRun } from "@/lib/graph/intro-signal";
import { IGNITION_FRACTIONS, type ChronoFrame } from "@/lib/warp/chrono";

/**
 * The constellation's intro: a jump to lightspeed, scoped to the canvas box.
 *
 * A deliberate sibling of `src/components/warp/chrono-stage.tsx` rather than a variant of it.
 * That one drives the `/upgrade` transition and is dense with concerns this has none of —
 * route-swap cover, `covered` pinning for skip, inbound/landing legs, and a click-swallowing
 * rule written specifically to protect Stripe buttons. Branching all of that on a mode prop
 * would make both files worse, and that file is live. The shared part — the timing — is shared
 * properly, through `introFrame`, which is `chronoFrame` with a faster collapse and a longer
 * hold.
 *
 * The motion is NOT that file's. `/upgrade` turns its field about a fixed pole, which reads as
 * hours passing; this one flies straight into the frame, which reads as going somewhere. That
 * is the right metaphor here: the chart is not ageing while you wait, it is arriving. Stars
 * stream out of a vanishing point at the centre and past the camera, so the payoff is a
 * deceleration out of lightspeed with the constellation already sitting where the vanishing
 * point was.
 *
 * The shared envelope survives the change intact. `chronoFrame`'s speed term is `omega` because
 * it was written for a rotation, but its shape — standstill, eased acceleration, hold at peak,
 * decelerating return to rest — is precisely a hyperspace jump, so `introThrottle` reads it as
 * a normalised throttle and this file applies it along the line of travel. The shutter needs no
 * reinterpretation at all: a long exposure of stars flying at the camera is streaks radiating
 * from the vanishing point, and closing it on arrival collapses them back into points.
 *
 * It paints NO sky of its own. `paintSpace()`'s gradient and nebulae are a different sky from
 * the graph's `.constellation-milky-way`, so cross-fading one into the other would be a
 * luminance step at the exact moment of the payoff. Instead the canvas is transparent except
 * for the trail layer, and the ground showing through is the graph's own — so the hand-off is
 * invisible by construction rather than by matching two palettes by hand.
 */

type Star = {
  /**
   * Offset from the vanishing point in px AT THE FAR PLANE; the projection divides it by depth.
   *
   * Held in pixels, and scaled to the frame's own half-width and half-height rather than to one
   * isotropic focal length. The canvas box is wide and short — roughly 2.7:1 — so a round
   * far plane sized to fit it vertically wastes the width, and one sized to the diagonal puts
   * every star off the top or bottom within a third of its run. Matching the box means a star
   * stays in view for most of its approach whichever way it is heading.
   */
  dx: number;
  dy: number;
  /** Depth: 1 at the far plane, 0 at the camera. */
  z: number;
  /** Base radius in px, before the near-field swell. */
  r: number;
  gold: boolean;
  /**
   * Which cruise wave brought this star into the field; -1 for the base field.
   *
   * The reserve is what stops a long hold reading as a loop. Hyperspace is a steady state by
   * nature, so left alone a nine-second wait would show the same density for nine seconds —
   * instead each wave thickens the field, and the sky keeps arriving for as long as the load
   * does.
   */
  wave: number;
  /** Last frame's projection, so the streak is a segment and not a dotted line. */
  sx: number;
  sy: number;
  /** False for one frame after a respawn, when there is no previous point to join. */
  drawn: boolean;
};

/**
 * One star per this many square px, capped.
 *
 * Far sparser than the rotating field this replaced, and the first pass got it badly wrong by
 * carrying that density over: every star draws a segment every frame, so at speed a dense field
 * fills the frame with overlapping rays and reads as a sunburst — a static graphic — rather
 * than as travel. Hyperspace is mostly black with distinct streaks in it; the gaps are what
 * make the streaks read as objects going past.
 */
const STAR_AREA = 3600;
const STAR_CAP = 520;

/**
 * The shortest the exposure is allowed to get, whatever the shared envelope says.
 *
 * `ALPHA_FAST` is 0.045 — about a 22-frame tail — which is right for a rotation, where a star
 * crosses a few px per frame and the tail is a graceful arc. Here a star can cross hundreds,
 * so the same tail stretches from the vanishing point clean off the frame and every streak
 * merges into its neighbours. The floor only bites at speed: at rest the envelope's own 0.55
 * is already shorter, and on arrival it closes to 1 and collapses the streaks to points.
 */
const SHUTTER_FLOOR = 0.15;
/**
 * Nearest approach before a star is recycled to the far plane.
 *
 * Not zero: the projection divides by `z`, so a star allowed to reach the camera would swing
 * through an unbounded jump and paint a line across the whole frame on its last frame.
 */
const Z_NEAR = 0.045;
/**
 * Keeps a clear disc around the vanishing point.
 *
 * Two reasons, and both matter. Stars sampled near dead centre barely move however fast the
 * field travels, so they sit as a static clot in the middle of a shot whose whole subject is
 * motion. And the centre is where the sun lands when the chart arrives — leaving it open means
 * the constellation emerges from the vanishing point rather than out of a bright knot.
 */
const CORE = 0.06;
/** A backgrounded tab returns with an enormous delta; without this the whole field would jump
 *  the depth in one frame. Belt and braces alongside the visibility pause below. */
const MAX_DT = 0.05;
/** How much a star swells as it comes at you, on top of its base radius. */
const NEAR_SWELL = 2.2;
/** Depth over which a new star fades up, so nothing pops in at the far plane. */
const FADE_IN_Z = 0.28;

/**
 * How much of the frame the field spans at the far plane.
 *
 * Well inside it, NOT filling it. The projection divides by depth, so a star's distance from
 * the centre grows as it approaches: a field that already fills the frame at the far plane is
 * off-screen within a fraction of its run, and almost every star spends its life flying through
 * territory nobody can see. At 0.4 a star stays in view for roughly the first 60% of its
 * approach, which is what puts streaks on screen at a density worth looking at.
 */
const FAR_PLANE_FILL = 0.4;

const STAR_WHITE = "255,255,255";
const STAR_GOLD = "255,214,140";

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
    let cx = 0;
    let cy = 0;
    let stars: Star[] = [];
    let trail: HTMLCanvasElement | null = null;
    let trailCtx: CanvasRenderingContext2D | null = null;

    function frameNow(now: number): ChronoFrame {
      const r = runRef.current;
      const elapsed = now - r.startedAt;
      return introFrame(
        introPhase(r.status, elapsed),
        elapsed,
        r.arrivingAt === null ? 0 : now - r.arrivingAt
      );
    }

    /**
     * Whether a star's wave has arrived in this frame.
     *
     * `bursts` is the shared frame's name for the counter — it lights stars in place on
     * `/upgrade`, where the sky is growing rather than travelling. The count is the same; here
     * it releases a wave into the field instead.
     */
    function isActive(f: ChronoFrame, wave: number) {
      return wave < 0 || f.bursts > wave;
    }

    function project(s: Star) {
      return [cx + s.dx / s.z, cy + s.dy / s.z] as const;
    }

    /**
     * Place a star somewhere in the volume ahead.
     *
     * `sqrt` on the radius keeps areal density even across the frame rather than crowding the
     * centre, and `CORE` holds the vanishing point open. `z` is random rather than 1 so the
     * initial field is spread through the depth instead of arriving as one wall.
     */
    function spawn(s: Star, z: number) {
      const angle = Math.random() * Math.PI * 2;
      const radius = (CORE + (1 - CORE) * Math.sqrt(Math.random())) * FAR_PLANE_FILL;
      s.dx = Math.cos(angle) * radius * cx;
      s.dy = Math.sin(angle) * radius * cy;
      s.z = z;
      // Squared, so most stars are small and a few are notably bigger. A uniform draw gives an
      // evenly-sized field, which at speed is a wall of identical strokes.
      s.r = 0.3 + Math.random() ** 2 * 1.5;
      s.gold = Math.random() < 0.06;
      s.drawn = false;
    }

    function newStar(wave: number, z: number): Star {
      const s: Star = {
        dx: 0,
        dy: 0,
        z: 1,
        r: 1,
        gold: false,
        wave,
        sx: 0,
        sy: 0,
        drawn: false,
      };
      spawn(s, z);
      return s;
    }

    function buildField() {
      const count = Math.min(Math.floor((width * height) / STAR_AREA), STAR_CAP);
      // Spread through the depth so the first frame is a field, not an empty tunnel.
      stars = Array.from({ length: count }, () =>
        newStar(-1, Z_NEAR + Math.random() * (1 - Z_NEAR))
      );

      // The reserve: stars only a hold can reach. Their wave indices start where the scripted
      // seven end, so they arrive one wave at a time for as long as the wait runs.
      const reserve = Math.floor(count * INTRO_RESERVE_FRACTION);
      for (let i = 0; i < reserve; i += 1) {
        const wave = IGNITION_FRACTIONS.length + Math.floor(i / 2);
        stars.push(newStar(wave, Z_NEAR + Math.random() * (1 - Z_NEAR)));
      }
    }

    function resize() {
      const prevTrail = trail;
      const prevCx = cx;
      const prevCy = cy;

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

      // Dead centre. A hyperspace field is symmetric about the point it is travelling toward,
      // and that point is where the sun lands when the chart arrives underneath.
      cx = width / 2;
      cy = height / 2;
      // The trail layer is never cleared — that accumulation IS the exposure — so it is its own
      // canvas, composited over the ground each frame.
      const t = document.createElement("canvas");
      t.width = Math.floor(width * dpr);
      t.height = Math.floor(height * dpr);
      const tctx = t.getContext("2d");
      if (!tctx) return;
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tctx.lineCap = "round";
      // Carry the exposure across a resize rather than starting blank. This matters more here
      // than on a route transition: the graph pane genuinely can be resized mid-run, by the
      // fullscreen toggle.
      if (prevTrail) tctx.drawImage(prevTrail, 0, 0, width, height);
      trail = t;
      trailCtx = tctx;

      if (stars.length > 0) {
        // Keep the field across a resize; rebuilding re-randomises every position mid-flight,
        // which reads as the sky being swapped out. Offsets are in px, so they scale with the
        // box — and the cached projection is stale, which is one frame of streak.
        const kx = prevCx > 0 ? cx / prevCx : 1;
        const ky = prevCy > 0 ? cy / prevCy : 1;
        for (const s of stars) {
          s.dx *= kx;
          s.dy *= ky;
          s.drawn = false;
        }
        return;
      }
      buildField();
    }

    function draw(now: number) {
      raf = requestAnimationFrame(draw);
      const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_DT);
      last = now;
      if (!trail || !trailCtx || width < 2) return;

      const f = frameNow(now);

      ctx!.clearRect(0, 0, width, height);

      // The shutter. Erasing a fraction of the layer leaves the rest as trail: a low alpha
      // leaves long streaks, 1 leaves bare points. Floored — see SHUTTER_FLOOR.
      //
      // Compounded over real time rather than applied once per frame, which is not a detail.
      // Erasing a fixed fraction per frame makes the trail a fixed number of FRAMES long, while
      // the distance a star covers in one frame scales with the frame time — so at 20fps each
      // streak is three times longer than at 60 and the whole field collapses into the
      // sunburst this animation is specifically not meant to be. Caught by watching a throttled
      // tab paint exactly that. Raising it to `dt * 60` makes the tail a fixed length in
      // SECONDS, so a slow machine sees the same picture as a fast one, just fewer times.
      trailCtx.globalCompositeOperation = "destination-out";
      const shutter =
        1 - (1 - Math.max(f.alpha, SHUTTER_FLOOR)) ** Math.max(dt * 60, 0);
      trailCtx.fillStyle = `rgba(0,0,0,${shutter})`;
      trailCtx.fillRect(0, 0, width, height);
      trailCtx.globalCompositeOperation = "source-over";

      const step = introThrottle(f) * INTRO_WARP_SPEED * dt;
      for (const s of stars) {
        if (!isActive(f, s.wave)) continue;

        s.z -= step;
        if (s.z <= Z_NEAR) {
          // Past the camera. Recycled to the far plane rather than removed, so the field is a
          // fixed cost however long the wait runs.
          spawn(s, 1);
        }

        const [x, y] = project(s);

        // Off the frame entirely — remember where it went so the streak stays continuous if it
        // comes back, but draw nothing.
        const out = x < -64 || x > width + 64 || y < -64 || y > height + 64;
        if (out) {
          s.sx = x;
          s.sy = y;
          s.drawn = false;
          continue;
        }

        const near = 1 - s.z;
        const alpha = Math.min(1, near / FADE_IN_Z);
        const radius = s.r * (1 + near * NEAR_SWELL);
        const rgb = s.gold ? STAR_GOLD : STAR_WHITE;
        trailCtx.fillStyle = `rgba(${rgb},${0.8 * alpha})`;
        trailCtx.strokeStyle = `rgba(${rgb},${0.85 * alpha})`;

        if (s.drawn) {
          // A segment from where it was to where it is. At speed a star crosses hundreds of
          // pixels between frames, so plotting points alone would leave a dotted line; joining
          // them is what makes the streak — and its length is the speed, which is the shot.
          trailCtx.lineWidth = radius * 2;
          trailCtx.beginPath();
          trailCtx.moveTo(s.sx, s.sy);
          trailCtx.lineTo(x, y);
          trailCtx.stroke();
        } else {
          trailCtx.beginPath();
          trailCtx.arc(x, y, radius, 0, Math.PI * 2);
          trailCtx.fill();
        }

        s.sx = x;
        s.sy = y;
        s.drawn = true;
      }

      // `lighter` so trails add light over the ground rather than punching a hole in it.
      ctx!.globalCompositeOperation = "lighter";
      ctx!.drawImage(trail, 0, 0, width, height);
      ctx!.globalCompositeOperation = "source-over";

      const r = runRef.current;
      const elapsed = now - r.startedAt;
      canvas!.style.opacity = String(
        introCoverage(
          introPhase(r.status, elapsed),
          elapsed,
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
      // Every cached projection is now from before the pause; joining to it would draw one
      // streak across the whole frame.
      for (const s of stars) s.drawn = false;
      raf = requestAnimationFrame(draw);
    }

    const ro = new ResizeObserver(() => resize());
    ro.observe(parent);
    document.addEventListener("visibilitychange", onVisibility);

    resize();
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
