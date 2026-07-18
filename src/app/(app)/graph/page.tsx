import { NetworkGraph } from "@/components/graph/network-graph";

export default function GraphPage() {
  return (
    <div className="-mx-1 space-y-4 md:-mx-2">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#3d7a6c]">
            Star chart
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e] md:text-4xl">
            Constellation
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            You are the brightest star. Closer ties sit nearer; companies form
            named constellations. Straight lines link people who share a
            company, event, or known connection — click any star to inspect.
          </p>
        </div>
      </div>
      <NetworkGraph />
    </div>
  );
}
