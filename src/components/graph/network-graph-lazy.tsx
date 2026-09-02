"use client";

import dynamic from "next/dynamic";
import type { getGraphData } from "@/actions/graph";
import { ConstellationLoading } from "@/components/graph/constellation-loading";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;

const NetworkGraphFull = dynamic(
  () =>
    import("@/components/graph/network-graph").then((m) => ({
      default: m.NetworkGraph,
    })),
  {
    ssr: false,
    loading: () => (
      <ConstellationLoading className="h-[calc(100dvh-15rem)] md:h-[calc(100dvh-10.5rem)]" />
    ),
  }
);

const NetworkGraphCompact = dynamic(
  () =>
    import("@/components/graph/network-graph").then((m) => ({
      default: m.NetworkGraph,
    })),
  {
    ssr: false,
    loading: () => <ConstellationLoading className="h-[300px]" />,
  }
);

export function NetworkGraphLazy({
  initialData = null,
  compact = false,
}: {
  initialData?: GraphPayload | null;
  compact?: boolean;
}) {
  if (compact) {
    return <NetworkGraphCompact initialData={initialData} compact />;
  }

  return <NetworkGraphFull initialData={initialData} />;
}
