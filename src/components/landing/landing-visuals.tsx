"use client";

import dynamic from "next/dynamic";

const Starfield = dynamic(
  () =>
    import("@/components/landing/starfield").then((m) => ({
      default: m.Starfield,
    })),
  { ssr: false }
);

/**
 * `interactive` turns on the cursor gravity well and the signup pulse (see
 * `starfield.tsx`). Off by default: the landing, pricing and docs skies are shared
 * with the warp stages' cross-fade and must stay exactly as they are.
 */
export function LandingStarfield({ interactive = false }: { interactive?: boolean }) {
  return <Starfield interactive={interactive} />;
}
