"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { CONSTELLATION_STAGE_HEIGHT } from "@/components/graph/constellation-loading";
import { predictSlowIntro } from "@/lib/graph/intro-choreography";
import { STAGE_INTRO_LAYER } from "@/lib/graph/stage-layers";
import {
  beginIntro,
  getIntroRun,
  isGraphChunkLoaded,
  registerIntroHost,
  subscribe,
  suppressIntro,
  type IntroRun,
} from "@/lib/graph/intro-signal";
import { cn } from "@/lib/utils";

/**
 * The warp intro's host, mounted as a SIBLING of the graph's Suspense boundary.
 *
 * The placement is the whole trick. Everything that could own this instead — `GraphIsland`,
 * `NetworkGraphLazy`, `NetworkGraph`, `GraphCanvasInner` — is unmounted and replaced at some
 * point during a load, and `GraphCanvasInner` is additionally remounted on every change to the
 * contact id set (a focus refetch, the show-all toggle, and once per batch during a refresh).
 * From up here the canvas and its accumulated exposure survive every one of those, so a long
 * wait reads as one continuous shot rather than a series of restarts. It also means the intro
 * exists during the chunk download, which is the phase most worth covering and the one nothing
 * below the boundary can even see.
 *
 * The stage is loaded lazily and only ever requested when a run actually starts, so the fast
 * path does not pay for the canvas code it is not going to use.
 */

const WarpStage = dynamic(
  () =>
    import("@/components/graph/constellation-warp-stage").then((m) => ({
      default: m.ConstellationWarpStage,
    })),
  { ssr: false }
);

export function ConstellationIntro() {
  // Seeded from the bus rather than re-read in the effect: `beginIntro` publishes, and the
  // subscription is attached before any decision is made, so every subsequent state change
  // arrives through it. Calling setState synchronously inside the effect would only add a
  // cascading render for a value we already have.
  const [run, setRun] = useState<IntroRun>(getIntroRun);
  /**
   * Whether this visit has already decided. A ref rather than state because a re-render must
   * not re-ask, and it lives HERE — not in the bus — so that navigating away and back is a
   * fresh visit and does get an intro, while everything remounting beneath it does not.
   */
  const decided = useRef(false);

  useEffect(() => {
    const release = registerIntroHost();
    const unsubscribe = subscribe(setRun);

    if (!decided.current) {
      decided.current = true;

      // Read the media query directly rather than through `usePrefersReducedMotion`: that hook
      // returns false on its first render and corrects in an effect, which is exactly long
      // enough to ship an animation to someone who asked for none.
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const forced =
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("warp");

      if (forced === "off") {
        // Must also kill the late fallback, or "off" only turns off the predictive triggers
        // and the safety net still fires 1.2s later.
        suppressIntro();
      } else if (forced === "force") {
        beginIntro("forced");
      } else {
        // Decision one, made before the chunk request can even start: has the graph module
        // ever evaluated in this document? `contactCount` is deliberately null — the payload is
        // still streaming behind the boundary, and "not known yet" must not read as "slow".
        const { warp, reason } = predictSlowIntro({
          reduced,
          chunkLoaded: isGraphChunkLoaded(),
          contactCount: null,
          cores:
            typeof navigator !== "undefined"
              ? (navigator.hardwareConcurrency ?? null)
              : null,
        });
        if (warp && reason) beginIntro(reason);
      }
    }

    return () => {
      unsubscribe();
      release();
    };
  }, []);

  if (run.status === "idle" || run.status === "done") return null;

  return (
    <div
      // Absolutely positioned within the canvas box, which is why every stand-in and the real
      // stage had to agree on one height — see CONSTELLATION_STAGE_HEIGHT.
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 overflow-hidden rounded-2xl",
        // Above the loading panel, below the chart — so the stars fly BEHIND the constellation
        // rather than over it, and settle at the depth its own background field occupies.
        STAGE_INTRO_LAYER,
        CONSTELLATION_STAGE_HEIGHT
      )}
      // Contributes nothing to the accessibility tree: the `role="status"` live region in the
      // loading panel underneath is still there and still announcing, merely covered visually.
      aria-hidden
      data-intro-reason={run.reason ?? undefined}
    >
      <WarpStage run={run} />
    </div>
  );
}
