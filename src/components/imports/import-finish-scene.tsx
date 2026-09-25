"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import {
  breathAt,
  buildScene,
  countAt,
  depthAlpha,
  depthScale,
  DOT_RADIUS,
  photoReveal,
  poseAt,
  SCENE_HEIGHT,
  TILT,
  type Scene,
  type SceneBody,
} from "@/lib/imports/finish-scene-geometry";
import { initialsFromName } from "@/lib/initials";

/** The planet at the centre: the app's own asset, 192px so a 46px draw is sharp at 2×. */
const PLANET_SRC = "/imports/earth.webp";

/**
 * The people's colours, one per body in turn, taken from the landing page's planets.
 *
 * Literal hex rather than CSS variables: a canvas `fillStyle` needs a value it can parse, and
 * these are decorative. Each set is tuned for its surface: mid-tones on the light card, lifted
 * ones on the dark card. `edge` is the gold ring round a face.
 */
const PALETTE = {
  light: {
    ring: "#94a3b8",
    bodies: ["#3f7cc4", "#c65f3c", "#b8874f", "#4a67c9", "#2f9bb0", "#b8912f"],
    initials: "#ffffff",
    edge: "#fcd34d",
  },
  dark: {
    ring: "#cbd5e1",
    bodies: ["#7fb0ea", "#ec8a66", "#dcae7a", "#8aa0f0", "#6fd0e0", "#e6c46a"],
    initials: "#0f1a2b",
    edge: "#fde68a",
  },
} as const;

/** A trail is this many segments, each this many seconds of travel apart. */
const TRAIL_STEPS = 8;
const TRAIL_STEP_SECONDS = 0.022;
/** The ring that flashes out where a body settles lasts this long. */
const SETTLE_FLASH_SECONDS = 0.45;
/** Longest frame the clock will count, so a stalled tab does not skip the arrival. */
const MAX_FRAME_SECONDS = 0.05;

export type FinishArrival = "live" | "settled";

/**
 * The people an import added, arriving.
 *
 * The maths lives next door in `finish-scene-geometry.ts`; this file owns pixels and lifetime.
 *
 * - **`arrival`.** `"live"` plays the fall-in from the start. `"settled"` begins at the end:
 *   everyone already in place, rings turning, planet breathing. That is the card a person comes
 *   back to.
 * - **The clock only runs while someone can see it.** The loop stops off-screen or in a hidden
 *   tab, and time is summed frame by frame (capped), not read off the wall clock. So a run that
 *   finishes in a background tab plays when the person looks, instead of having finished unseen.
 * - **Reduced motion** paints the settled frame once, planet still, and reports the final count
 *   at once. The preference is read with `matchMedia` at effect time, never through a hook that
 *   reports the wrong value on its first render.
 * - **`onCount`** hears the headline's number whenever it changes: 0 until the first body
 *   settles, then up to exactly `people`. It is called only on change, not every frame.
 *
 * Height comes from `SCENE_HEIGHT` through CSS variables and a breakpoint class, so the first
 * paint is the right height at every width. The effect reads the box CSS laid out, and a
 * `ResizeObserver` rebuilds the scene when that box changes.
 */
export function ImportFinishScene({
  people,
  faces,
  arrival = "live",
  onCount,
}: {
  people: number;
  faces: { contactId: string; name: string; photo: string | null }[];
  arrival?: FinishArrival;
  onCount?: (count: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Latest callback without restarting the scene when a parent passes a new function.
  const onCountRef = useRef(onCount);
  useEffect(() => {
    onCountRef.current = onCount;
  }, [onCount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      // Nothing will ever count up, so say the whole number rather than leave it at nothing.
      onCountRef.current?.(people);
      return;
    }

    let disposed = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const font = getComputedStyle(canvas).fontFamily || "system-ui, sans-serif";

    let scene: Scene | null = null;
    let elapsed = 0;
    let lastCount = -1;
    let running = !reduced;
    let visible = true;
    let raf = 0;
    let lastFrame = 0;

    const planet = new Image();
    planet.onload = () => {
      if (!disposed && (reduced || !raf)) paintNow();
    };
    planet.src = PLANET_SRC;

    // Photos for the faces that have one, each stamped with when it arrived on the scene's
    // clock: a face turns from initials into its photo once it has both settled and loaded. A
    // miss (the on-demand route's 404) never loads, so that face simply keeps its initials. No
    // `crossOrigin`: the canvas is only drawn to, never read back, and asking for CORS made
    // every avatar host that doesn't send the header fail.
    const photos = new Map<number, { img: HTMLImageElement; readyAt: number }>();
    faces.forEach((face, i) => {
      if (!face.photo) return;
      const img = new Image();
      img.onload = () => {
        if (disposed) return;
        // Under reduced motion there is no turning: the photo is simply there.
        photos.set(i, { img, readyAt: reduced ? -Infinity : elapsed });
        if (reduced || !raf) paintNow();
      };
      img.src = face.photo;
    });

    function report(t: number) {
      if (!scene) return;
      const count = countAt(scene, t);
      if (count === lastCount) return;
      lastCount = count;
      onCountRef.current?.(count);
    }

    function paint(t: number) {
      if (!scene) return;
      const c = ctx!;
      const palette = document.documentElement.classList.contains("dark")
        ? PALETTE.dark
        : PALETTE.light;
      const { width, height, cx, cy, radii, faceRadius } = scene;
      c.clearRect(0, 0, width, height);

      // The rings, fading in fully as people reach them.
      const firstPass = scene.bodies.reduce((m, b) => Math.min(m, b.pass), Infinity);
      const ringAlpha = Math.min(1, Math.max(0.3, (t - firstPass) / 1.5));
      radii.forEach((r, i) => {
        c.beginPath();
        c.ellipse(cx, cy, r, r * TILT, 0, 0, Math.PI * 2);
        c.strokeStyle = palette.ring;
        c.globalAlpha = (i === 1 ? 0.35 : 0.25) * ringAlpha;
        c.lineWidth = 1;
        c.stroke();
      });

      const posed = scene.bodies
        .map((body) => ({ body, pose: poseAt(scene!, body, t) }))
        .sort((a, b) => a.pose.depth - b.pose.depth);

      const drawPlanet = () => {
        if (!planet.complete || !planet.naturalWidth) return;
        const size = scene!.planetSize * (reduced ? 1 : breathAt(t));
        c.globalAlpha = 1;
        c.drawImage(planet, cx - size / 2, cy - size / 2, size, size);
      };

      // Back half, then the planet, then the front half: the planet hides what passes behind.
      let planetDrawn = false;
      for (const { body, pose } of posed) {
        if (!planetDrawn && pose.depth >= 0.5) {
          drawPlanet();
          planetDrawn = true;
        }
        drawBody(c, body, pose, t, palette, faceRadius, font);
      }
      if (!planetDrawn) drawPlanet();
      c.globalAlpha = 1;
    }

    function drawBody(
      c: CanvasRenderingContext2D,
      body: SceneBody,
      pose: { x: number; y: number; depth: number },
      t: number,
      palette: (typeof PALETTE)["light" | "dark"],
      faceRadius: number,
      family: string,
    ) {
      const isFace = body.faceIndex >= 0;
      const scale = depthScale(pose.depth);
      const alpha = depthAlpha(pose.depth);
      const colour = palette.bodies[body.colorIndex % palette.bodies.length];
      const r = (isFace ? faceRadius : DOT_RADIUS) * scale;

      // A trail while it is still moving faster than its ring; its length is its speed.
      if (t < body.settleAt) {
        c.lineCap = "round";
        for (let k = 0; k < TRAIL_STEPS; k++) {
          const a = poseAt(scene!, body, t - k * TRAIL_STEP_SECONDS);
          const b = poseAt(scene!, body, t - (k + 1) * TRAIL_STEP_SECONDS);
          if (Math.hypot(a.x - b.x, a.y - b.y) < 0.6) break;
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.strokeStyle = colour;
          c.globalAlpha = alpha * 0.45 * (1 - k / TRAIL_STEPS);
          c.lineWidth = Math.max(1, r * 1.1 * (1 - k / 10));
          c.stroke();
        }
      }

      // A thin ring flashing out where it settles.
      const since = t - body.settleAt;
      if (since >= 0 && since < SETTLE_FLASH_SECONDS) {
        const k = since / SETTLE_FLASH_SECONDS;
        c.beginPath();
        c.arc(pose.x, pose.y, r + (isFace ? 10 : 6) * (1 - (1 - k) ** 3), 0, Math.PI * 2);
        c.strokeStyle = isFace ? palette.edge : colour;
        c.globalAlpha = (isFace ? 0.7 : 0.4) * (1 - k);
        c.lineWidth = 1.2;
        c.stroke();
      }

      c.globalAlpha = alpha;
      if (!isFace) {
        c.beginPath();
        c.arc(pose.x, pose.y, r, 0, Math.PI * 2);
        c.fillStyle = colour;
        c.fill();
        return;
      }

      // A face: its initials, turning into its photo once it has settled and the photo is in.
      // The disc swells a touch mid-turn and settles back, so the change reads as the person
      // arriving rather than a picture swapping in.
      const photo = photos.get(body.faceIndex);
      const reveal = photo ? photoReveal(t, body.settleAt, photo.readyAt) : 0;
      const fr = r * (1 + 0.08 * Math.sin(Math.PI * reveal));
      if (reveal < 1) {
        c.beginPath();
        c.arc(pose.x, pose.y, fr, 0, Math.PI * 2);
        c.fillStyle = colour;
        c.fill();
        const name = faces[body.faceIndex]?.name;
        if (name && fr > 7.5) {
          c.globalAlpha = alpha * (1 - reveal);
          c.fillStyle = palette.initials;
          c.font = `500 ${Math.round(fr * 0.78)}px ${family}`;
          c.textAlign = "center";
          c.textBaseline = "middle";
          c.fillText(initialsFromName(name), pose.x, pose.y + 0.5);
        }
      }
      if (photo && reveal > 0) {
        c.save();
        c.globalAlpha = alpha * reveal;
        c.beginPath();
        c.arc(pose.x, pose.y, fr, 0, Math.PI * 2);
        c.clip();
        c.drawImage(photo.img, pose.x - fr, pose.y - fr, fr * 2, fr * 2);
        c.restore();
      }
      c.globalAlpha = alpha;
      c.beginPath();
      c.arc(pose.x, pose.y, fr, 0, Math.PI * 2);
      c.strokeStyle = palette.edge;
      c.lineWidth = 1.25;
      c.stroke();
    }

    function paintNow() {
      paint(elapsed);
      report(elapsed);
    }

    const loop = (now: number) => {
      if (!running || !visible) {
        raf = 0;
        return;
      }
      elapsed += Math.min(MAX_FRAME_SECONDS, (now - lastFrame) / 1000);
      lastFrame = now;
      paintNow();
      raf = requestAnimationFrame(loop);
    };

    function resume() {
      if (!running || !visible || raf || !scene) return;
      lastFrame = performance.now();
      raf = requestAnimationFrame(loop);
    }

    function resize() {
      // Both dimensions come off the box CSS laid out; nothing here writes them back.
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      if (w < 2 || h < 2) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const first = !scene;
      scene = buildScene(people, w, h);
      // Just past the end, once the last settle's flash has faded: a settled scene is at rest.
      if (first && (arrival === "settled" || reduced)) {
        elapsed = scene.duration + SETTLE_FLASH_SECONDS;
      }
      paintNow();
      resume();
    }

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    if (reduced) {
      return () => {
        disposed = true;
        resizeObserver.disconnect();
      };
    }

    const setVisible = (next: boolean) => {
      visible = next;
      if (next) resume();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    const intersectionObserver = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting && !document.hidden),
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    return () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [people, faces, arrival]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // Tailwind's `sm` is the phone/desktop line, as everywhere else in the app. The class names
      // the variables; `SCENE_HEIGHT` fills them in below, so the numbers are written once.
      className="block w-full h-[var(--finish-scene-phone)] sm:h-[var(--finish-scene-desktop)]"
      style={SCENE_HEIGHT_VARS}
    />
  );
}

/** `SCENE_HEIGHT`, as the custom properties the canvas's height classes read. */
const SCENE_HEIGHT_VARS = {
  "--finish-scene-phone": `${SCENE_HEIGHT.phone}px`,
  "--finish-scene-desktop": `${SCENE_HEIGHT.desktop}px`,
} as CSSProperties;
