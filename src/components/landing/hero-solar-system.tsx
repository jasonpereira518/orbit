"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type PlanetDef = {
  id: string;
  /** Orbit radius in SVG units */
  orbit: number;
  size: number;
  startAngle: number;
  duration: string;
  gradientId: string;
  atmosphereId: string;
  /** Saturn only */
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
    size: 5,
    startAngle: 40,
    duration: "24s",
    gradientId: "hero-p-mercury",
    atmosphereId: "hero-atmo-mercury",
  },
  {
    id: "venus",
    orbit: 78,
    size: 8,
    startAngle: 130,
    duration: "36s",
    gradientId: "hero-p-venus",
    atmosphereId: "hero-atmo-venus",
  },
  {
    id: "earth",
    orbit: 100,
    size: 9,
    startAngle: 220,
    duration: "48s",
    gradientId: "hero-p-earth",
    atmosphereId: "hero-atmo-earth",
  },
  {
    id: "mars",
    orbit: 122,
    size: 6.5,
    startAngle: 310,
    duration: "62s",
    gradientId: "hero-p-mars",
    atmosphereId: "hero-atmo-mars",
  },
  {
    id: "jupiter",
    orbit: 148,
    size: 18,
    startAngle: 75,
    duration: "88s",
    gradientId: "hero-p-jupiter",
    atmosphereId: "hero-atmo-jupiter",
  },
  {
    id: "saturn",
    orbit: 176,
    size: 15,
    startAngle: 185,
    duration: "112s",
    gradientId: "hero-p-saturn",
    atmosphereId: "hero-atmo-saturn",
    hasRings: true,
  },
  {
    id: "uranus",
    orbit: 200,
    size: 11,
    startAngle: 265,
    duration: "140s",
    gradientId: "hero-p-uranus",
    atmosphereId: "hero-atmo-uranus",
  },
  {
    id: "neptune",
    orbit: 222,
    size: 10.5,
    startAngle: 20,
    duration: "168s",
    gradientId: "hero-p-neptune",
    atmosphereId: "hero-atmo-neptune",
  },
];

const ORBIT_RADII = PLANETS.map((p) => p.orbit);
const CX = 220;
const CY = 220;

function PlanetBody({ p }: { p: PlanetDef }) {
  const isBanded = p.id === "jupiter" || p.id === "saturn";
  return (
    <g filter={`url(#hero-planet-${p.id})`}>
      <circle r={p.size * 2.1} fill={`url(#${p.atmosphereId})`} />
      {p.hasRings && (
        <ellipse
          cx={0}
          cy={0}
          rx={p.size * 2.15}
          ry={p.size * 0.55}
          fill="none"
          stroke="rgba(210, 190, 140, 0.55)"
          strokeWidth={1.6}
          opacity={0.85}
        />
      )}
      <circle r={p.size} fill={`url(#${p.gradientId})`} />
      {isBanded && <circle r={p.size} fill="url(#hero-p-band-shade)" />}
      <circle r={p.size} fill="url(#hero-p-specular)" opacity={0.65} />
      <circle
        r={p.size}
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth={0.35}
      />
    </g>
  );
}

export function HeroSolarSystem({ className }: { className?: string }) {
  const [motionOk] = useState(() => {
    if (typeof window === "undefined") return true;
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  return (
    <div
      className={cn(
        "hero-solar relative mx-auto aspect-square w-full max-w-[560px]",
        "landing-solar-enter",
        className
      )}
      aria-hidden
    >
      <svg
        viewBox="0 0 440 440"
        className="h-full w-full overflow-visible"
        role="presentation"
      >
        <defs>
          {PLANETS.map((p) => (
            <filter
              key={p.id}
              id={`hero-planet-${p.id}`}
              x="-120%"
              y="-120%"
              width="340%"
              height="340%"
            >
              <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          ))}

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

          {/* Atmospheres */}
          <radialGradient id="hero-atmo-mercury" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(170, 160, 150, 0.22)" />
            <stop offset="55%" stopColor="rgba(170, 160, 150, 0)" />
          </radialGradient>
          <radialGradient id="hero-atmo-venus" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(220, 190, 120, 0.28)" />
            <stop offset="55%" stopColor="rgba(220, 190, 120, 0)" />
          </radialGradient>
          <radialGradient id="hero-atmo-earth" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(80, 160, 220, 0.28)" />
            <stop offset="55%" stopColor="rgba(80, 160, 220, 0)" />
          </radialGradient>
          <radialGradient id="hero-atmo-mars" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(200, 100, 70, 0.26)" />
            <stop offset="55%" stopColor="rgba(200, 100, 70, 0)" />
          </radialGradient>
          <radialGradient id="hero-atmo-jupiter" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(200, 160, 100, 0.24)" />
            <stop offset="55%" stopColor="rgba(200, 160, 100, 0)" />
          </radialGradient>
          <radialGradient id="hero-atmo-saturn" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(210, 190, 140, 0.22)" />
            <stop offset="55%" stopColor="rgba(210, 190, 140, 0)" />
          </radialGradient>
          <radialGradient id="hero-atmo-uranus" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(140, 210, 210, 0.24)" />
            <stop offset="55%" stopColor="rgba(140, 210, 210, 0)" />
          </radialGradient>
          <radialGradient id="hero-atmo-neptune" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(70, 120, 220, 0.28)" />
            <stop offset="55%" stopColor="rgba(70, 120, 220, 0)" />
          </radialGradient>

          {/* Surfaces — approximate real-world look */}
          <radialGradient id="hero-p-mercury" cx="36%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#d0c8c0" />
            <stop offset="50%" stopColor="#8a8278" />
            <stop offset="100%" stopColor="#2a2824" />
          </radialGradient>
          <radialGradient id="hero-p-venus" cx="34%" cy="28%" r="72%">
            <stop offset="0%" stopColor="#fff0c8" />
            <stop offset="40%" stopColor="#e0b860" />
            <stop offset="100%" stopColor="#6a4820" />
          </radialGradient>
          <radialGradient id="hero-p-earth" cx="36%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#c8e8ff" />
            <stop offset="28%" stopColor="#3a8fd0" />
            <stop offset="55%" stopColor="#2a7850" />
            <stop offset="100%" stopColor="#0a2030" />
          </radialGradient>
          <radialGradient id="hero-p-mars" cx="36%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#f0b090" />
            <stop offset="40%" stopColor="#c05030" />
            <stop offset="100%" stopColor="#3a1008" />
          </radialGradient>
          <linearGradient id="hero-p-jupiter" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#e8d0a0" />
            <stop offset="14%" stopColor="#c89858" />
            <stop offset="28%" stopColor="#8a6038" />
            <stop offset="42%" stopColor="#d8b878" />
            <stop offset="56%" stopColor="#a07040" />
            <stop offset="70%" stopColor="#6a4828" />
            <stop offset="85%" stopColor="#c09058" />
            <stop offset="100%" stopColor="#3a2810" />
          </linearGradient>
          <linearGradient id="hero-p-saturn" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#f0e4c0" />
            <stop offset="25%" stopColor="#d8c090" />
            <stop offset="50%" stopColor="#b8a068" />
            <stop offset="75%" stopColor="#908050" />
            <stop offset="100%" stopColor="#4a4028" />
          </linearGradient>
          <radialGradient id="hero-p-band-shade" cx="34%" cy="28%" r="75%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.25)" />
            <stop offset="45%" stopColor="rgba(255,255,255,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.35)" />
          </radialGradient>
          <radialGradient id="hero-p-uranus" cx="36%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#d8f8f8" />
            <stop offset="40%" stopColor="#70c8c8" />
            <stop offset="100%" stopColor="#184848" />
          </radialGradient>
          <radialGradient id="hero-p-neptune" cx="36%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#b0d0ff" />
            <stop offset="35%" stopColor="#3868d0" />
            <stop offset="100%" stopColor="#081838" />
          </radialGradient>
          <radialGradient id="hero-p-specular" cx="32%" cy="26%" r="38%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
        </defs>

        {/* Sun */}
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

        {/* One ring per planet */}
        <g className="hero-solar-rings">
          {ORBIT_RADII.map((r) => (
            <circle
              key={r}
              cx={CX}
              cy={CY}
              r={r}
              fill="none"
              stroke="rgba(122, 168, 150, 0.12)"
              strokeWidth={0.5}
            />
          ))}
        </g>

        {/* Eight planets, one per orbit */}
        {PLANETS.map((p) => (
          <g key={p.id} transform={`translate(${CX} ${CY})`}>
            <g transform={motionOk ? undefined : `rotate(${p.startAngle})`}>
              {motionOk && (
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from={`${p.startAngle} 0 0`}
                  to={`${p.startAngle + 360} 0 0`}
                  dur={p.duration}
                  repeatCount="indefinite"
                />
              )}
              <g transform={`translate(${p.orbit} 0)`}>
                <PlanetBody p={p} />
              </g>
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}
