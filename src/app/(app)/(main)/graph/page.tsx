import { getGraphData } from "@/actions/graph";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";

export default async function GraphPage() {
  const initialData = await getGraphData();

  return (
    <div className="-mx-1 space-y-3 overflow-hidden md:-mx-2">
      <div className="shrink-0 px-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-primary">
          Star chart
        </p>
        <h1 className="mt-0.5 font-[family-name:var(--font-display)] text-2xl text-primary md:text-3xl">
          Constellation
        </h1>
        <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
          You are the sun. Companies and schools form constellations around
          you — each figure traced by its own people.
        </p>
      </div>
      <NetworkGraphLazy initialData={initialData} />
    </div>
  );
}
