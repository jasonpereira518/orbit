"use client";

import dynamic from "next/dynamic";
import type { HeroSolarCamera } from "@/components/landing/hero-solar-system";

const Starfield = dynamic(
  () =>
    import("@/components/landing/starfield").then((m) => ({
      default: m.Starfield,
    })),
  { ssr: false }
);

const HeroSolarSystem = dynamic(
  () =>
    import("@/components/landing/hero-solar-system").then((m) => ({
      default: m.HeroSolarSystem,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden
        className="aspect-square w-full rounded-full bg-[radial-gradient(circle_at_center,rgba(232,243,241,0.08),transparent_65%)]"
      />
    ),
  }
);

/**
 * `interactive` turns on the cursor gravity well and the signup pulse (see
 * `starfield.tsx`). Off by default: the landing, pricing and docs skies are shared
 * with the warp stages' cross-fade and must stay exactly as they are.
 */
export function LandingStarfield({ interactive = false }: { interactive?: boolean }) {
  return <Starfield interactive={interactive} />;
}

export function LandingSolarSystem({
  className,
  camera,
}: {
  className?: string;
  camera?: HeroSolarCamera;
}) {
  return <HeroSolarSystem className={className} camera={camera} />;
}
