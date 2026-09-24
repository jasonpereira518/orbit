"use client";

import dynamic from "next/dynamic";
import { useEffect, useSyncExternalStore } from "react";
import { CONSTELLATION_STAGE_HEIGHT } from "@/components/graph/constellation-loading";
import { predictSlowIntro } from "@/lib/graph/intro-choreography";
import { STAGE_INTRO_LAYER } from "@/lib/graph/stage-layers";
import {
  beginIntro,
  getIdleIntroRun,
  getIntroRun,
  isGraphChunkLoaded,
  registerIntroHost,
  subscribe,
  suppressIntro,
} from "@/lib/graph/intro-signal";
import { SMALL_SKY_QUERY } from "@/components/graph/use-small-sky";
import { preloadConstellation } from "@/components/graph/constellation-modules";
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
  /**
   * Read through `useSyncExternalStore`, not a `useState` fed by `subscribe`.
   *
   * That was the warp that never ended. When this effect is torn down and re-run — StrictMode
   * does it on every dev mount, and any real remount of the host does the same — the teardown
   * resets the bus to idle, but the component has already unsubscribed by then, so it never
   * heard. Its state stayed "running", the bus was idle, and the chart's ready signal had no
   * run to end: the stars flew forever over a finished constellation. `useSyncExternalStore`
   * re-reads the bus whenever it resubscribes, so this can never disagree with it.
   */
  const run = useSyncExternalStore(subscribe, getIntroRun, getIdleIntroRun);

  useEffect(() => {
    const release = registerIntroHost();

    // Decided on every mount of the host, never carried across one. Releasing the host resets
    // the run, so a remount that kept an earlier "already decided" (as a ref once did) was left
    // with no run and no way to start one. Nothing beneath the host re-runs this effect: it
    // depends on nothing, so the payload streaming in and the chart remounting leave it alone,
    // and navigating away and back is a fresh visit.

    // Read the media query directly rather than through `usePrefersReducedMotion`: that hook
    // returns false on its first render and corrects in an effect, which is exactly long
    // enough to ship an animation to someone who asked for none.
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const forced =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("warp");

    /**
     * Never on the canvas renderer.
     *
     * The intro exists to cover React Flow mounting N DOM nodes — `predictSlowIntro`
     * is a model of exactly that cost. The canvas mount is `getContext("2d")` and one
     * draw, so the minimum beat would now be ADDING time to a fast load, which is the
     * failure `scripts/smoke-graph-intro.ts` already guards against. Suppressed rather
     * than skipped, because suppression also kills the late fallback.
     */
    const smallSky =
      typeof window !== "undefined" &&
      window.matchMedia(SMALL_SKY_QUERY).matches;

    if (forced === "off" || (smallSky && forced !== "force")) {
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

    // After decision one has read whether the chunk is cold. This host hydrates with the page
    // shell, long before the payload streams in behind the boundary, so the chart's code
    // downloads alongside the data instead of after it.
    preloadConstellation();

    return release;
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
