"use client";

import { Profiler, useEffect, useState, type ProfilerOnRenderCallback } from "react";
import { ConstellationIntro } from "@/components/graph/constellation-intro";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";
import { buildSyntheticGraphPayload } from "@/lib/graph/synthetic-network";
import { STAGE_GROUND } from "@/lib/graph/stage-layers";

type BenchCommit = { phase: string; actual: number; base: number; at: number };

type BenchState = {
  n: number;
  /** performance.now() when the synthetic payload started building. */
  startedAt: number;
  payloadMs: number;
  commits: BenchCommit[];
};

declare global {
  interface Window {
    __bench?: BenchState;
  }
}

/**
 * Every commit under the chart, as React's own Profiler reports it.
 *
 * `actualDuration` is the render cost of that commit (what React DevTools' flame chart shows);
 * the driver sums it per phase of the scenario. Needs a `next build --profile` build, where
 * the Profiler is live in production React.
 */
const onRender: ProfilerOnRenderCallback = (_id, phase, actual, base, _start, commitTime) => {
  window.__bench?.commits.push({ phase, actual, base, at: commitTime });
};

export function ConstellationBench() {
  const [payload, setPayload] = useState<ReturnType<typeof buildSyntheticGraphPayload> | null>(
    null
  );

  // After hydration, not during render: the page is server-rendered and the size lives in the
  // URL. The real page's payload also only reaches the chart after its own boundary resolves.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const n = Math.max(1, Number(params.get("n") ?? 1000));
    const startedAt = performance.now();
    const data = buildSyntheticGraphPayload(n, { seed: Number(params.get("seed") ?? 1) });
    window.__bench = {
      n,
      startedAt,
      payloadMs: performance.now() - startedAt,
      commits: [],
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- runs once, after hydration, by design (see above)
    setPayload(data);
  }, []);

  if (!payload) return null;

  // The same nesting as src/app/(clerk)/(app)/(main)/graph/page.tsx, so the stage has the
  // same box, the intro the same host, and the chart the same lazy chunk.
  return (
    <div className="min-h-dvh bg-background p-4">
      <div className="-mx-1 space-y-3 overflow-hidden md:-mx-2">
        <h1 className="px-1 font-[family-name:var(--font-display)] text-2xl text-ink md:text-3xl">
          Constellation bench · {payload.contacts.length.toLocaleString()} contacts
        </h1>
        <div className={`relative rounded-2xl ${STAGE_GROUND}`}>
          <ConstellationIntro />
          <Profiler id="constellation" onRender={onRender}>
            <NetworkGraphLazy initialData={payload} />
          </Profiler>
        </div>
      </div>
    </div>
  );
}
