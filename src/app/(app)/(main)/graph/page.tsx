import { getGraphData } from "@/actions/graph";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";

export default async function GraphPage() {
  const initialData = await getGraphData();

  return (
    <div className="-mx-1 space-y-4 md:-mx-2">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-primary">
            Star chart
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl text-primary md:text-4xl">
            Constellation
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            You are the sun. People form constellations by company, then
            school — linked to each other, not to the center.
          </p>
        </div>
      </div>
      <NetworkGraphLazy initialData={initialData} />
    </div>
  );
}
