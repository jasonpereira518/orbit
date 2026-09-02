import { Suspense } from "react";
import { getGraphData } from "@/actions/graph";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";
import { GraphPageSkeleton } from "@/components/loading/page-skeletons";

/**
 * The heading paints from the layout immediately; the full-network scan streams in behind
 * a Suspense boundary. Before, the page awaited the scan at the top, so the first byte
 * waited for the whole payload — on a large network, seconds of blank.
 */
export default function GraphPage() {
  return (
    <div className="-mx-1 space-y-3 overflow-hidden md:-mx-2">
      <div className="shrink-0 px-1">
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
      <Suspense fallback={<GraphPageSkeleton />}>
        <GraphIsland />
      </Suspense>
    </div>
  );
}

async function GraphIsland() {
  const initialData = await getGraphData();
  return <NetworkGraphLazy initialData={initialData} />;
}
