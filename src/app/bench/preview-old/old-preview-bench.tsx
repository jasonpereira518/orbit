"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { buildSyntheticGraphPayload } from "@/lib/graph/synthetic-network";

const NetworkGraph = dynamic(
  () => import("@/components/graph/network-graph").then((m) => ({ default: m.NetworkGraph })),
  { ssr: false }
);

export function OldPreviewBench() {
  const payload = useMemo(() => buildSyntheticGraphPayload(150), []);
  return (
    <main className="mx-auto max-w-xl p-6">
      <NetworkGraph initialData={payload} compact />
    </main>
  );
}
