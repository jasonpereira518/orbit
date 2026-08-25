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

export function LandingStarfield() {
  return <Starfield />;
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
