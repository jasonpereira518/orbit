"use client";

import dynamic from "next/dynamic";
import type { getGraphData } from "@/actions/graph";
import { Skeleton } from "@/components/ui/skeleton";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;

const NetworkGraph = dynamic(
  () =>
    import("@/components/graph/network-graph").then((m) => ({
      default: m.NetworkGraph,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-[min(78vh,720px)] w-full rounded-2xl bg-[#05070c]" />
    ),
  }
);

export function NetworkGraphLazy({
  initialData = null,
}: {
  initialData?: GraphPayload | null;
}) {
  return <NetworkGraph initialData={initialData} />;
}
