import { PLANET_GLOW, type WelcomePlanet } from "@/lib/welcome-planets";
import { cn } from "@/lib/utils";

/**
 * Planets whose art includes rings (Saturn, Uranus): the landing hero
 * (`hero-solar-system.tsx`, `hasArtRings`) gives these a 1.4× box so the sphere itself
 * reads the same diameter as the ringless planets, with the rings spilling outside it,
 * plus the `hero-planet-3d--art-rings` atmosphere modifier (tighter inset, lower opacity).
 */
const RINGED: ReadonlySet<WelcomePlanet> = new Set(["saturn", "uranus"]);
const ART_RING_SCALE = 1.4;

/**
 * One planet from `public/landing/planets/`, with the landing hero's glow treatment
 * (`hero-planet-atmosphere` in globals.css). Server-safe: no hooks, no motion.
 */
export function PlanetArt({
  planet,
  size,
  className,
}: {
  planet: WelcomePlanet;
  /** CSS px. */
  size: number;
  className?: string;
}) {
  const ringed = RINGED.has(planet);
  return (
    <span
      className={cn("relative inline-block shrink-0", ringed && "hero-planet-3d--art-rings", className)}
      style={{ width: size, height: size, ["--planet-glow" as string]: PLANET_GLOW[planet] }}
      aria-hidden="true"
    >
      <picture>
        <source type="image/avif" srcSet={`/landing/planets/${planet}.avif`} />
        <source type="image/webp" srcSet={`/landing/planets/${planet}.webp`} />
        <img
          className="hero-planet-art"
          src={`/landing/planets/${planet}.png`}
          alt=""
          width={size}
          height={size}
          draggable={false}
          style={ringed ? { transform: `scale(${ART_RING_SCALE})`, transformOrigin: "50% 50%" } : undefined}
        />
      </picture>
      <span className="hero-planet-atmosphere" />
    </span>
  );
}
