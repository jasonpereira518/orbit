import { tourAnchor } from "@/lib/tour/tour-anchors";
import { Suspense } from "react";
import { getGraphData } from "@/actions/graph";
import { ConstellationIntro } from "@/components/graph/constellation-intro";
import { ConstellationScopeToggle } from "@/components/graph/constellation-scope-toggle";
import {
  ConstellationLoading,
  CONSTELLATION_STAGE_HEIGHT,
} from "@/components/graph/constellation-loading";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";
import { STAGE_GROUND } from "@/lib/graph/stage-layers";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";

/**
 * The heading paints from the layout immediately; the full-network scan streams in behind
 * a Suspense boundary. Before, the page awaited the scan at the top, so the first byte
 * waited for the whole payload — on a large network, seconds of blank.
 */
export default function GraphPage() {
  return (
    <div className="-mx-1 space-y-3 overflow-hidden md:-mx-2">
      <RenderStamp />
      {/*
        The scope toggle is here, in the header, rather than over the canvas: the canvas is
        where the stars are, so anything sitting on it is either covering the network or
        getting out of the way of it.

        `items-end` sits it at the FOOT of the header, immediately above the chart's top-right
        corner. Aligned to the top instead it landed level with the app's notification bell —
        near enough to read as a third piece of app chrome, when it is a control for this one
        chart and belongs next to it.
      */}
      {/* `compact`: on a phone the description costs the chart ~62px of height, and the Key
          in the chart's corner explains the same picture on demand. The stage height
          (CONSTELLATION_STAGE_HEIGHT) is sized for this header at both breakpoints. */}
      <PageHeader
        eyebrow="Star chart"
        title="Constellation"
        subtitle="You are the sun. Companies and schools form constellations around you — each figure traced by its own people."
        compact
        actions={<ConstellationScopeToggle className="mb-0.5 shrink-0" />}
        className="items-end px-1 md:px-2"
      />
      {/*
        The intro sits OUTSIDE the boundary so it outlives every phase swap beneath it — the
        payload streaming, the chunk landing, and every canvas remount thereafter. Inside, it
        would be unmounted and restarted at each handover.

        The fallback is the bare canvas panel, not `GraphPageSkeleton`: the real <h1> above is
        outside the boundary and already painted, so the skeleton's own header bars used to
        render underneath it — a real heading and a grey fake one on screen together.
        `loading.tsx` still uses the full skeleton, where nothing has painted yet.
      */}
      {/*
        The wrapper paints the ground, not the chart's own stage.
        The intro sits BETWEEN the two states of this box — over the loading panel it covers,
        under the chart it hands over to — so the chart has to be transparent for it to show
        through from behind. Something has to hold the near-black, and the box that outlives
        both of them is the honest place for it. Same colour either way, so the handover when
        the stage takes its background back is not a step.
      */}
      <div className={`relative rounded-2xl ${STAGE_GROUND}`} {...tourAnchor("graph.stage")}>
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
