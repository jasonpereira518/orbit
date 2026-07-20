"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/components/onboarding/use-prefers-reduced-motion";

type PlanetDef = {
  id: string;
  orbit: number;
  size: number;
  startAngle: number;
  duration: string;
  spinDuration: string;
  glow: string;
  hasRings?: boolean;
};

/**
 * Real solar system order, one planet per ring.
 * Orbit radii and periods are stylized (not to scale) but preserve relative feel.
 */
const PLANETS: PlanetDef[] = [
  {
    id: "mercury",
    orbit: 58,
    size: 6,
    startAngle: 40,
    duration: "24s",
    spinDuration: "7s",
    glow: "rgba(170, 160, 150, 0.45)",
  },
  {
    id: "venus",
    orbit: 78,
    size: 9,
    startAngle: 130,
    duration: "36s",
    spinDuration: "16s",
    glow: "rgba(220, 190, 120, 0.5)",
  },
  {
    id: "earth",
    orbit: 100,
    size: 10,
    startAngle: 220,
    duration: "48s",
    spinDuration: "10s",
    glow: "rgba(80, 160, 220, 0.55)",
  },
  {
    id: "mars",
    orbit: 122,
    size: 7.5,
    startAngle: 310,
    duration: "62s",
    spinDuration: "11s",
    glow: "rgba(200, 100, 70, 0.5)",
  },
  {
    id: "jupiter",
    orbit: 148,
    size: 20,
    startAngle: 75,
    duration: "88s",
    spinDuration: "5.5s",
    glow: "rgba(200, 160, 100, 0.45)",
  },
  {
    id: "saturn",
    orbit: 176,
    size: 16,
    startAngle: 185,
    duration: "112s",
    spinDuration: "6.5s",
    glow: "rgba(210, 190, 140, 0.45)",
    hasRings: true,
  },
  {
    id: "uranus",
    orbit: 200,
    size: 12,
    startAngle: 265,
    duration: "140s",
    spinDuration: "9s",
    glow: "rgba(140, 210, 210, 0.5)",
  },
  {
    id: "neptune",
    orbit: 222,
    size: 11.5,
    startAngle: 20,
    duration: "168s",
    spinDuration: "9.5s",
    glow: "rgba(70, 120, 220, 0.55)",
  },
];

const ORBIT_RADII = PLANETS.map((p) => p.orbit);
const CX = 220;
const CY = 220;
const VIEW = 440;

/** Resting camera angle — slight top-down view of the ecliptic. */
const BASE_TILT_X = 28;
const BASE_TILT_Y = -12;
const MAX_POINTER_TILT = 18;

function parseSeconds(duration: string) {
  return Number.parseFloat(duration) || 1;
}

function planetPosition(p: PlanetDef, elapsedMs: number, motionOk: boolean) {
  const periodMs = parseSeconds(p.duration) * 1000;
  const angleDeg = motionOk
    ? p.startAngle + (elapsedMs / periodMs) * 360
    : p.startAngle;
  const rad = (angleDeg * Math.PI) / 180;
  const x = CX + p.orbit * Math.cos(rad);
  const y = CY + p.orbit * Math.sin(rad);
  const z = p.orbit * Math.sin(rad) * 0.35;
  return { x, y, z };
}

function applyPlanetTransform(
  el: HTMLElement,
  p: PlanetDef,
  elapsedMs: number,
  motionOk: boolean
) {
  const { x, y, z } = planetPosition(p, elapsedMs, motionOk);
  el.style.left = `${(x / VIEW) * 100}%`;
  el.style.top = `${(y / VIEW) * 100}%`;
  el.style.transform = `translate3d(-50%, -50%, ${z}px)`;
  el.style.zIndex = String(Math.round(100 + z));
}

function PlanetSphere({ p, spin }: { p: PlanetDef; spin: boolean }) {
  const diameter = (p.size * 2) / VIEW;
  const initial = planetPosition(p, 0, false);

  return (
    <div
      className={cn("hero-planet-3d", `hero-planet-3d--${p.id}`)}
      data-planet={p.id}
      style={{
        left: `${(initial.x / VIEW) * 100}%`,
        top: `${(initial.y / VIEW) * 100}%`,
        width: `${diameter * 100}%`,
        height: `${diameter * 100}%`,
        transform: `translate3d(-50%, -50%, ${initial.z}px)`,
        ["--planet-glow" as string]: p.glow,
        ["--planet-spin" as string]: spin ? p.spinDuration : "0s",
      }}
    >
      {p.hasRings && (
        <div className="hero-planet-rings" aria-hidden>
          <span className="hero-planet-ring hero-planet-ring--back" />
          <span className="hero-planet-ring hero-planet-ring--mid" />
          <span className="hero-planet-ring hero-planet-ring--front" />
        </div>
      )}
      <div className="hero-planet-sphere">
        <div
          className={cn(
            "hero-planet-texture",
            spin && "hero-planet-texture--spin"
          )}
        />
        <div className="hero-planet-shade" />
        <div className="hero-planet-specular" />
        <div className="hero-planet-rim" />
      </div>
      <div className="hero-planet-atmosphere" />
    </div>
  );
}

export function HeroSolarSystem({ className }: { className?: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const tiltNodeRef = useRef<HTMLDivElement>(null);
  const planetsRef = useRef<HTMLDivElement>(null);
  const targetTilt = useRef({ x: BASE_TILT_X, y: BASE_TILT_Y });
  const currentTilt = useRef({ x: BASE_TILT_X, y: BASE_TILT_Y });
  const startTime = useRef(0);
  const motionOk = !reducedMotion;

  useEffect(() => {
    startTime.current = performance.now();

    const planetEls = new Map<string, HTMLElement>();
    const root = planetsRef.current;
    if (root) {
      for (const p of PLANETS) {
        const el = root.querySelector<HTMLElement>(`[data-planet="${p.id}"]`);
        if (el) planetEls.set(p.id, el);
      }
    }

    if (!motionOk) {
      currentTilt.current = { x: BASE_TILT_X, y: BASE_TILT_Y };
      if (tiltNodeRef.current) {
        tiltNodeRef.current.style.transform = `rotateX(${BASE_TILT_X}deg) rotateY(${BASE_TILT_Y}deg)`;
      }
      for (const p of PLANETS) {
        const el = planetEls.get(p.id);
        if (el) applyPlanetTransform(el, p, 0, false);
      }
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;

      const rect = stage.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      const nx = (event.clientX - midX) / Math.max(window.innerWidth * 0.45, 1);
      const ny =
        (event.clientY - midY) / Math.max(window.innerHeight * 0.45, 1);
      const clampedX = Math.max(-1, Math.min(1, nx));
      const clampedY = Math.max(-1, Math.min(1, ny));

      targetTilt.current = {
        x: BASE_TILT_X - clampedY * MAX_POINTER_TILT,
        y: BASE_TILT_Y + clampedX * MAX_POINTER_TILT,
      };
    };

    const onPointerLeave = () => {
      targetTilt.current = { x: BASE_TILT_X, y: BASE_TILT_Y };
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", onPointerLeave);

    let raf = 0;
    const tick = (now: number) => {
      const cur = currentTilt.current;
      const next = targetTilt.current;
      const ease = 0.08;
      const x = cur.x + (next.x - cur.x) * ease;
      const y = cur.y + (next.y - cur.y) * ease;
      currentTilt.current = { x, y };

      if (tiltNodeRef.current) {
        tiltNodeRef.current.style.transform = `rotateX(${x}deg) rotateY(${y}deg)`;
      }

      const elapsed = now - startTime.current;
      for (const p of PLANETS) {
        const el = planetEls.get(p.id);
        if (el) applyPlanetTransform(el, p, elapsed, true);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onPointerLeave);
      cancelAnimationFrame(raf);
    };
  }, [motionOk]);

  return (
    <div
      ref={stageRef}
      className={cn(
        "hero-solar relative mx-auto aspect-square w-full max-w-[560px]",
        "landing-solar-enter",
        className
      )}
      style={{ perspective: "1100px", perspectiveOrigin: "50% 45%" }}
      aria-hidden
    >
      <div
        ref={tiltNodeRef}
        className="hero-solar-stage relative h-full w-full will-change-transform"
        style={{
          transform: `rotateX(${BASE_TILT_X}deg) rotateY(${BASE_TILT_Y}deg)`,
          transformStyle: "preserve-3d",
        }}
      >
        <svg
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          role="presentation"
        >
          <defs>
            <filter
              id="hero-sun-bloom"
              x="-120%"
              y="-120%"
              width="340%"
              height="340%"
            >
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <radialGradient id="hero-sun-halo-outer" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(255, 200, 80, 0.12)" />
              <stop offset="40%" stopColor="rgba(94, 234, 212, 0.1)" />
              <stop offset="100%" stopColor="rgba(15, 61, 62, 0)" />
            </radialGradient>
            <radialGradient id="hero-sun-halo-mid" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(255, 210, 100, 0.35)" />
              <stop offset="45%" stopColor="rgba(94, 234, 212, 0.2)" />
              <stop offset="100%" stopColor="rgba(15, 61, 62, 0)" />
            </radialGradient>
            <radialGradient id="hero-sun-core" cx="38%" cy="34%" r="62%">
              <stop offset="0%" stopColor="#fff8e8" />
              <stop offset="25%" stopColor="#ffe08a" />
              <stop offset="55%" stopColor="#e8a030" />
              <stop offset="85%" stopColor="#c46818" />
              <stop offset="100%" stopColor="#6b3010" />
            </radialGradient>
          </defs>

          <g className="hero-solar-sun" transform={`translate(${CX} ${CY})`}>
            <circle
              className="hero-solar-corona-outer"
              r={56}
              fill="url(#hero-sun-halo-outer)"
            />
            <circle
              className="hero-solar-corona"
              r={38}
              fill="url(#hero-sun-halo-mid)"
            />
            <circle
              r={22}
              fill="url(#hero-sun-core)"
              filter="url(#hero-sun-bloom)"
            />
            <circle cx={-4} cy={-5} r={5} fill="rgba(255,255,255,0.4)" />
          </g>

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
        </svg>

        <div
          ref={planetsRef}
          className="pointer-events-none absolute inset-0"
          style={{ transformStyle: "preserve-3d" }}
        >
          {PLANETS.map((p) => (
            <PlanetSphere key={p.id} p={p} spin={motionOk} />
          ))}
        </div>
      </div>
    </div>
  );
}
