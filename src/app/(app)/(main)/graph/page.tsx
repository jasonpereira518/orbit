import { Suspense } from "react";
import { getGraphData } from "@/actions/graph";
import { ConstellationIntro } from "@/components/graph/constellation-intro";
import { ConstellationScopeToggle } from "@/components/graph/constellation-scope-toggle";
import {
  ConstellationLoading,
  CONSTELLATION_STAGE_HEIGHT,
} from "@/components/graph/constellation-loading";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";

/**
 * The heading paints from the layout immediately; the full-network scan streams in behind
 * a Suspense boundary. Before, the page awaited the scan at the top, so the first byte
 * waited for the whole payload — on a large network, seconds of blank.
 */
export default function GraphPage() {
  return (
    <div className="-mx-1 space-y-3 overflow-hidden md:-mx-2">
      {/*
        The scope toggle is here, in the header, rather than over the canvas: the canvas is
        where the stars are, so anything sitting on it is either covering the network or
        getting out of the way of it.

        `items-end` sits it at the FOOT of the header, immediately above the chart's top-right
        corner. Aligned to the top instead it landed level with the app's notification bell —
        near enough to read as a third piece of app chrome, when it is a control for this one
        chart and belongs next to it.
      */}
      <div className="flex shrink-0 items-end justify-between gap-3 px-1">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-primary">
            Star chart
          </p>
          <h1 className="mt-0.5 font-[family-name:var(--font-display)] text-2xl text-ink md:text-3xl">
            Constellation
          </h1>
          <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
            You are the sun. Companies and schools form constellations around
            you — each figure traced by its own people.
          </p>
        </div>
        <ConstellationScopeToggle className="mb-0.5 shrink-0" />
      </div>
      {/*
        The intro sits OUTSIDE the boundary so it outlives every phase swap beneath it — the
        payload streaming, the chunk landing, and every canvas remount thereafter. Inside, it
        would be unmounted and restarted at each handover.

        The fallback is the bare canvas panel, not `GraphPageSkeleton`: the real <h1> above is
        outside the boundary and already painted, so the skeleton's own header bars used to
        render underneath it — a real heading and a grey fake one on screen together.
        `loading.tsx` still uses the full skeleton, where nothing has painted yet.
      */}
      <div className="relative">
        <ConstellationIntro />
        <Suspense
          fallback={<ConstellationLoading className={CONSTELLATION_STAGE_HEIGHT} />}
        >
          <GraphIsland />
        </Suspense>
      </div>
    </div>
  );
}

async function GraphIsland() {
  const initialData = await getGraphData();
  return <NetworkGraphLazy initialData={initialData} />;
}
