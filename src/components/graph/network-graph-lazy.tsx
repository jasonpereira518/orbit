"use client";

import dynamic from "next/dynamic";
import type { getGraphData } from "@/actions/graph";
import { Skeleton } from "@/components/ui/skeleton";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;

const NetworkGraphFull = dynamic(
  () =>
    import("@/components/graph/network-graph").then((m) => ({
      default: m.NetworkGraph,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[calc(100dvh-15rem)] w-full rounded-2xl bg-[#05070c] md:h-[calc(100dvh-10.5rem)]" />
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
    loading: () => (
      <Skeleton className="h-[300px] w-full rounded-2xl bg-[#05070c]" />
    ),
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
