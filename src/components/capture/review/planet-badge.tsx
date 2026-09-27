"use client";

/**
 * The planet in the corner of a review card — one per person, in solar-system order.
 *
 * The first eight are the landing page's art, drawn with the same `<picture>` markup as
 * `PlanetSphere`; the rest are CSS spheres from the palette in `lib/capture/planets.ts`.
 * Both get the same glow behind and the same terminator shadow in front, which is what
 * makes a CSS Pluto sit next to a painted Neptune without looking like a different kit.
 * Decorative: `aria-hidden`, with the body's name as a title for the curious.
 */
import { planetForIndex, type PlanetDef } from "@/lib/capture/planets";
import { cn } from "@/lib/utils";

const SIZES = { xs: "size-6", sm: "size-10", md: "size-16", lg: "size-24" } as const;

export function PlanetBadge({
  index,
  size = "md",
  className,
  title,
}: {
  index: number;
  size?: keyof typeof SIZES;
  className?: string;
  /** Overrides the body's name — e.g. "Mercury · card 1 of 5". */
  title?: string;
}) {
  const planet = planetForIndex(index);
  return (
    <span
      aria-hidden
      title={title ?? planet.label}
      data-planet={planet.id}
      className={cn("relative isolate inline-block shrink-0 rounded-full", SIZES[size], className)}
      style={{ ["--planet-glow" as string]: planet.glow }}
    >
      <span className="hero-planet-atmosphere" />
      <PlanetSphere planet={planet} />
      {/* The terminator: a soft shadow on the limb away from the light, for both kinds. */}
      <span className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_-6px_-8px_14px_rgba(0,0,0,0.42)]" />
    </span>
  );
}

function PlanetSphere({ planet }: { planet: PlanetDef }) {
  if (planet.kind === "raster") {
    return (
      <picture className="block size-full">
        <source type="image/avif" srcSet={`/landing/planets/${planet.id}.avif`} />
        <source type="image/webp" srcSet={`/landing/planets/${planet.id}.webp`} />
        {/* eslint-disable-next-line @next/next/no-img-element -- static art in three formats; next/image cannot pick */}
        <img
          src={`/landing/planets/${planet.id}.png`}
          alt=""
          draggable={false}
          className={cn("block size-full select-none object-contain", planet.rings ? "scale-[1.35]" : "rounded-full")}
        />
      </picture>
    );
  }
  const [hi, mid, lo] = planet.stops;
  return (
    <span
      className="block size-full rounded-full"
      style={{
        background: `radial-gradient(circle at 32% 28%, ${hi} 0%, ${mid} 48%, ${lo} 100%)`,
      }}
    >
      {/* A little surface: two faint craters so the sphere is not a flat gradient. */}
      <span
        className="block size-full rounded-full opacity-40"
        style={{
          background: `radial-gradient(circle at 62% 60%, ${lo} 0 9%, transparent 10%), radial-gradient(circle at 40% 68%, ${lo} 0 5%, transparent 6%)`,
        }}
      />
    </span>
  );
}
