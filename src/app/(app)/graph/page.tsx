import { NetworkGraph } from "@/components/graph/network-graph";

export default function GraphPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-[#0f3d3e]">
          Network graph
        </h1>
        <p className="mt-1 text-muted-foreground">
          You at the center. Closer scores sit nearer; dormant contacts fade. Click a node to open their profile.
        </p>
      </div>
      <NetworkGraph />
    </div>
  );
}
