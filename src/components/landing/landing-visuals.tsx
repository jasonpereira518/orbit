"use client";

import dynamic from "next/dynamic";

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
        className="aspect-square w-full max-w-[min(100%,560px)] rounded-full bg-[radial-gradient(circle_at_center,rgba(232,243,241,0.08),transparent_65%)] lg:max-w-[580px]"
      />
    ),
  }
);

export function LandingStarfield() {
  return <Starfield />;
}

export function LandingSolarSystem({ className }: { className?: string }) {
  return <HeroSolarSystem className={className} />;
}
