"use client";

import { useLayoutEffect, useRef } from "react";
import { motion, type MotionValue } from "motion/react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

/**
 * Scroll-scrubbed camera values from the hero pin. The scrub writes only to
 * the stage tilt and the cadence-ring group — the rAF loop stays the sole
 * writer of per-planet transforms (two writers on one node is a hazard).
 * REST_TILT_X/Y in hero-pin.tsx mirror BASE_TILT_X/Y — keep in sync.
 */
export type HeroSolarCamera = {
  rotateX: MotionValue<number>;
  rotateY: MotionValue<number>;
  cadenceOpacity: MotionValue<number>;
};

type PlanetDef = {
  id: string;
  orbit: number;
  /** Visual sphere radius in view units (before ringed-art scale). */
  size: number;
  startAngle: number;
  duration: string;
  glow: string;
  /** PNG includes rings/moons — use a larger layout box. */
  hasArtRings?: boolean;
};

/**
 * Real solar system order, one planet per ring.
 * Circular orbits match the SVG guides so each body sits on its line.
 * startAngle: zig-zag around the clock so neighbors aren't a spiral arm.
 */
const PLANETS: PlanetDef[] = [
  {
    id: "mercury",
    orbit: 54,
    size: 8,
    startAngle: 18,
    duration: "16s",
    glow: "rgba(170, 160, 150, 0.45)",
  },
  {
    id: "venus",
    orbit: 78,
    size: 11,
    startAngle: 205,
    duration: "24s",
    glow: "rgba(220, 190, 120, 0.5)",
  },
  {
    id: "earth",
    orbit: 104,
    size: 12,
    startAngle: 112,
    duration: "34s",
    glow: "rgba(80, 160, 220, 0.55)",
  },
  {
    id: "mars",
    orbit: 128,
    size: 9,
    startAngle: 292,
    duration: "42s",
    glow: "rgba(200, 100, 70, 0.5)",
  },
  {
    id: "jupiter",
    orbit: 156,
    size: 16,
    startAngle: 168,
    duration: "78s",
    glow: "rgba(200, 160, 100, 0.45)",
  },
  {
    id: "saturn",
    orbit: 184,
    size: 12,
    startAngle: 48,
    duration: "105s",
    glow: "rgba(210, 190, 140, 0.45)",
    hasArtRings: true,
  },
  {
    id: "uranus",
    orbit: 210,
    size: 10,
    startAngle: 248,
    duration: "175s",
    glow: "rgba(140, 210, 210, 0.5)",
    hasArtRings: true,
  },
  {
    id: "neptune",
    orbit: 234,
    size: 11,
    startAngle: 128,
    duration: "220s",
    glow: "rgba(70, 120, 220, 0.55)",
  },
];

const ORBIT_RADII = PLANETS.map((p) => p.orbit);
const CX = 220;
const CY = 220;
const VIEW = 440;

/**
 * Hold start spacing through the enter animation so the opening
 * composition reads balanced before orbits begin.
 */
const START_HOLD_MS = 900;

/** Resting camera angle — slight top-down view of the ecliptic. */
const BASE_TILT_X = 28;
const BASE_TILT_Y = -12;

/** Ringed PNGs need a larger box so rings/moons aren't clipped. */
const ART_RING_SCALE = 1.4;

/** Sun art radius in view units (PNG includes rays/glow). */
const SUN_SIZE = 38;

function effectiveRadius(p: PlanetDef) {
  return p.size * (p.hasArtRings ? ART_RING_SCALE : 1);
}

function parseSeconds(duration: string) {
  return Number.parseFloat(duration) || 1;
}

function planetPosition(p: PlanetDef, elapsedMs: number, motionOk: boolean) {
  const periodMs = parseSeconds(p.duration) * 1000;
  const orbitElapsed = Math.max(0, elapsedMs - START_HOLD_MS);
  const angleDeg = motionOk
    ? p.startAngle + (orbitElapsed / periodMs) * 360
    : p.startAngle;
  const rad = (angleDeg * Math.PI) / 180;
  const x = CX + p.orbit * Math.cos(rad);
  const y = CY + p.orbit * Math.sin(rad);
  return { x, y };
}

function applyPlanetTransform(
  el: HTMLElement,
  p: PlanetDef,
  elapsedMs: number,
  motionOk: boolean,
  stagePx: number
) {
  const { x, y } = planetPosition(p, elapsedMs, motionOk);
  const px = (x / VIEW) * stagePx;
  const py = (y / VIEW) * stagePx;
  el.style.transform = `translate3d(${px}px, ${py}px, 0.5px) translate(-50%, -50%)`;
  const depth = Math.round(y);
  if (el.dataset.depth !== String(depth)) {
    el.dataset.depth = String(depth);
    el.style.zIndex = String(depth);
  }
}

function PlanetSphere({ p }: { p: PlanetDef }) {
  const diameter = (effectiveRadius(p) * 2) / VIEW;
  const initial = planetPosition(p, 0, false);

  return (
    <div
      className={cn(
        "hero-planet-3d",
        `hero-planet-3d--${p.id}`,
        p.hasArtRings && "hero-planet-3d--art-rings"
      )}
      data-planet={p.id}
      style={{
        width: `${diameter * 100}%`,
        height: `${diameter * 100}%`,
        transform: `translate3d(${(initial.x / VIEW) * VIEW}px, ${(initial.y / VIEW) * VIEW}px, 0.5px) translate(-50%, -50%)`,
        ["--planet-glow" as string]: p.glow,
      }}
    >
      <div className="hero-planet-sphere">
        {/* eslint-disable-next-line @next/next/no-img-element -- decorative hero art */}
        <img
          className="hero-planet-art"
          src={`/landing/planets/${p.id}.png`}
          alt=""
          draggable={false}
        />
      </div>
      <div className="hero-planet-atmosphere" />
    </div>
  );
}

/** The three labeled cadence rings (venus/jupiter/neptune orbits). */
const CADENCE_RADII = [78, 156, 234];

export function HeroSolarSystem({
  className,
  camera,
}: {
  className?: string;
  camera?: HeroSolarCamera;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const planetsRef = useRef<HTMLDivElement>(null);
  const startTime = useRef(0);
  const motionOk = !reducedMotion;

  useLayoutEffect(() => {
    startTime.current = performance.now();

    const planetEls = new Map<string, HTMLElement>();
    const root = planetsRef.current;
    if (root) {
      for (const p of PLANETS) {
        const el = root.querySelector<HTMLElement>(`[data-planet="${p.id}"]`);
        if (el) planetEls.set(p.id, el);
      }
    }

    let stagePx = root?.clientWidth ?? 0;
    const resize = () => {
      stagePx = root?.clientWidth ?? 0;
    };
    const ro = root ? new ResizeObserver(resize) : null;
    if (root && ro) ro.observe(root);

    if (!motionOk) {
      for (const p of PLANETS) {
        const el = planetEls.get(p.id);
        if (el) applyPlanetTransform(el, p, 0, false, stagePx);
      }
      return () => ro?.disconnect();
    }

    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - startTime.current;
      for (const p of PLANETS) {
        const el = planetEls.get(p.id);
        if (el) applyPlanetTransform(el, p, elapsed, true, stagePx);
      }
      raf = requestAnimationFrame(tick);
    };

    // Run orbits only while the stage is on screen in a foreground tab —
    // once the pinned hero scrolls away there is nothing to animate.
    let inView = true;
    const sync = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && inView) {
        raf = requestAnimationFrame(tick);
      }
    };
    const io = root
      ? new IntersectionObserver((entries) => {
          inView = entries[0]?.isIntersecting ?? true;
          sync();
        })
      : null;
    if (root && io) io.observe(root);
    sync();

    document.addEventListener("visibilitychange", sync);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", sync);
      io?.disconnect();
      ro?.disconnect();
    };
  }, [motionOk]);

  return (
    <div
      className={cn(
        "hero-solar relative mx-auto aspect-square w-full max-w-[560px] overflow-visible",
        "landing-solar-enter",
        className
      )}
      style={{ perspective: "1100px", perspectiveOrigin: "50% 45%" }}
      aria-hidden
    >
      <motion.div
        className="hero-solar-stage relative h-full w-full"
        style={
          camera
            ? {
                rotateX: camera.rotateX,
                rotateY: camera.rotateY,
                transformStyle: "preserve-3d",
              }
            : {
                transform: `rotateX(${BASE_TILT_X}deg) rotateY(${BASE_TILT_Y}deg)`,
                transformStyle: "preserve-3d",
              }
        }
      >
        <svg
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          role="presentation"
        >
          <g className="hero-solar-rings">
            {ORBIT_RADII.map((r) => (
              <circle
                key={r}
                cx={CX}
                cy={CY}
                r={r}
                fill="none"
                stroke="rgba(122, 168, 150, 0.18)"
                strokeWidth={0.5}
              />
            ))}
          </g>
          {camera ? (
            <motion.g style={{ opacity: camera.cadenceOpacity }}>
              {CADENCE_RADII.map((r) => (
                <circle
                  key={r}
                  cx={CX}
                  cy={CY}
                  r={r}
                  fill="none"
                  stroke="rgba(196, 163, 90, 0.4)"
                  strokeWidth={0.75}
                />
              ))}
            </motion.g>
          ) : null}
        </svg>

        <div
          className="hero-solar-sun pointer-events-none absolute left-1/2 top-1/2 z-[1]"
          style={{
            width: `${(SUN_SIZE * 2 * 100) / VIEW}%`,
            height: `${(SUN_SIZE * 2 * 100) / VIEW}%`,
            transform: "translate(-50%, -50%)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- decorative hero art */}
          <img
            className="hero-solar-sun-art h-full w-full object-contain"
            src="/landing/planets/sun.png"
            alt=""
            draggable={false}
          />
        </div>

        <div
          ref={planetsRef}
          className="pointer-events-none absolute inset-0 z-[2]"
          style={{ transformStyle: "preserve-3d" }}
        >
          {PLANETS.map((p) => (
            <PlanetSphere key={p.id} p={p} />
          ))}
        </div>
      </motion.div>
    </div>
  );
}
