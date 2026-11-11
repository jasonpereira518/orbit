"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { HeroSolarCamera } from "@/components/landing/hero-solar-system";

/**
 * Callers: landing-page.tsx, hero-pin.tsx, marketing-doc.tsx, interest/page.tsx,
 * pricing/page.tsx, upgrade/page.tsx. Defers heavy starfield/solar chunks until idle so
 * cold `/` LCP copy wins the connection. User: "Implement the plan as specified..."
 */

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
    loading: () => <SolarPlaceholder />,
  }
);

function SolarPlaceholder() {
  return (
    <div
      aria-hidden
      className="aspect-square w-full rounded-full bg-[radial-gradient(circle_at_center,rgba(232,243,241,0.08),transparent_65%)]"
    />
  );
}

/** Hold heavy hero chunks until after load + idle (capped by timeout). */
function useAfterIdle(timeoutMs = 2_000) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let idleId: number | undefined;
    let timeoutId: number | undefined;
    const go = () => setReady(true);
    const start = () => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(go, { timeout: timeoutMs });
      } else {
        timeoutId = window.setTimeout(go, Math.min(timeoutMs, 500));
      }
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => {
      if (idleId != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId != null) window.clearTimeout(timeoutId);
      window.removeEventListener("load", start);
    };
  }, [timeoutMs]);
  return ready;
}

/**
 * `interactive` turns on the cursor gravity well and the signup pulse (see
 * `starfield.tsx`). Off by default: the landing, pricing and docs skies are shared
 * with the warp stages' cross-fade and must stay exactly as they are.
 */
export function LandingStarfield({ interactive = false }: { interactive?: boolean }) {
  const ready = useAfterIdle();
  if (!ready) return null;
  return <Starfield interactive={interactive} />;
}

export function LandingSolarSystem({
  className,
  camera,
}: {
  className?: string;
  camera?: HeroSolarCamera;
}) {
  const ready = useAfterIdle();
  if (!ready) return <SolarPlaceholder />;
  return <HeroSolarSystem className={className} camera={camera} />;
}
