"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import type { getGraphData } from "@/actions/graph";
import { predictSlowIntro } from "@/lib/graph/intro-choreography";
import { beginIntro } from "@/lib/graph/intro-signal";
import {
  ConstellationLoading,
  CONSTELLATION_STAGE_HEIGHT,
} from "@/components/graph/constellation-loading";

type GraphPayload = Awaited<ReturnType<typeof getGraphData>>;

const NetworkGraphFull = dynamic(
  () =>
    import("@/components/graph/network-graph").then((m) => ({
      default: m.NetworkGraph,
    })),
  {
    ssr: false,
    loading: () => (
      <ConstellationLoading className={CONSTELLATION_STAGE_HEIGHT} />
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

/**
 * Decision two: the payload has arrived, so the layout cost is finally knowable.
 *
 * This component renders before the heavy chunk is even requested, which makes it the only
 * place in the pipeline that sees the contact count ahead of React Flow mounting that many
 * nodes. Only reachable when decision one (cold chunk, made in `ConstellationIntro`) declined,
 * because `beginIntro` is idempotent.
 *
 * Compact is excluded: the dashboard preview has no intro host above it, so a run started here
 * would have nowhere to draw. The bus refuses it anyway; this just avoids asking.
 */
function decideFromPayload(contactCount: number | null) {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { warp, reason } = predictSlowIntro({
    reduced,
    chunkLoaded: true,
    contactCount,
    cores:
      typeof navigator !== "undefined"
        ? (navigator.hardwareConcurrency ?? null)
        : null,
  });
  if (warp && reason) beginIntro(reason);
}

export function NetworkGraphLazy({
  initialData = null,
  compact = false,
}: {
  initialData?: GraphPayload | null;
  compact?: boolean;
}) {
  const contactCount = initialData?.contacts.length ?? null;
  // In an effect, not during render — this has a side effect on the intro bus. It still lands
  // well before the phase it predicts: the dynamic import below only starts on this same
  // commit, and the layout cost it is guarding against happens after that chunk resolves.
  // `beginIntro` is idempotent, so StrictMode's double-invoke is a no-op.
  useEffect(() => {
    if (compact) return;
    decideFromPayload(contactCount);
  }, [compact, contactCount]);

  if (compact) {
    return <NetworkGraphCompact initialData={initialData} compact />;
  }

  return <NetworkGraphFull initialData={initialData} />;
}
