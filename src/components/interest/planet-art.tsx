import { PLANET_GLOW, type WelcomePlanet } from "@/lib/welcome-planets";
import { cn } from "@/lib/utils";

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
  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
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
        />
      </picture>
      <span className="hero-planet-atmosphere" />
    </span>
  );
}
