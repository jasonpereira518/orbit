import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { tourAnchor } from "@/lib/tour/tour-anchors";
import { Suspense } from "react";
import { getConstellationGraphData, getGraphData } from "@/actions/graph";
import { getConstellationTabs } from "@/actions/custom-constellations";
import { ConstellationViewsMenu } from "@/components/graph/constellation-views-menu";
import { ConstellationGenerating } from "@/components/graph/constellation-generating";
import { ConstellationIntro } from "@/components/graph/constellation-intro";
import { ConstellationScopeToggle } from "@/components/graph/constellation-scope-toggle";
import {
  ConstellationLoading,
  CONSTELLATION_STAGE_HEIGHT,
} from "@/components/graph/constellation-loading";
import { NetworkGraphLazy } from "@/components/graph/network-graph-lazy";
import { skyMembersDigest } from "@/lib/graph/sky-key";
import { STAGE_GROUND } from "@/lib/graph/stage-layers";
import { RenderStamp } from "@/components/layout/render-stamp";

export const metadata = { title: "Constellation" };

/**
 * The heading and its controls (the views menu and Top | All) wait only for the short list of
 * saved views (`getConstellationTabs`: a few rows and counts); the full-network scan streams in
 * behind a Suspense boundary. Before, the
 * page awaited the scan at the top, so the first byte waited for the whole payload — on a
 * large network, seconds of blank.
 */
export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const gate = await pageVisibilityGate("page.graph");
  if (gate) return gate;

  const { c } = await searchParams;
  const { tabs, canCreate } = await getConstellationTabs();
  // Only a sky that is really in the caller's list counts. A stale or made-up `c` falls back to
  // Everyone, and the scope toggle (which sits above the Suspense boundary) has to follow suit.
  const active = typeof c === "string" ? (tabs.find((t) => t.id === c) ?? null) : null;
  const activeId = active?.id ?? null;

  return (
    <div className="-mx-1 space-y-3 overflow-hidden md:-mx-2">
      <RenderStamp />
      {/*
        The controls are here, on the title's row, rather than over the canvas: the canvas is
        where the stars are, so anything sitting on it is either covering the network or
        getting out of the way of it. One row at every width — no row of their own on a phone,
        so the chart keeps its full height (CONSTELLATION_STAGE_HEIGHT).

        `items-end` sits them at the FOOT of the header, immediately above the chart's top-right
        corner. Aligned to the top instead it landed level with the app's notification bell —
        near enough to read as a third piece of app chrome, when it is a control for this one
        chart and belongs next to it.
      */}
      <div className="flex shrink-0 items-end justify-between gap-2 px-1 sm:gap-3">
        {/* Below `md` the title holds its width (a second line would push the stage under the
            phone nav) and the views menu's label truncates instead. From `md` it is the
            description that gives way, so the controls keep their size. */}
        <div className="shrink-0 md:shrink">
          <p className="text-2xs font-medium uppercase tracking-[0.2em] text-primary">
            Star chart
          </p>
          <h1 className="mt-0.5 font-[family-name:var(--font-display)] text-2xl text-ink md:text-3xl">
            Constellation
          </h1>
          {/* Desktop only. On a phone these lines cost the chart ~62px of height, and the
              Key in the chart's corner explains the same picture on demand. The stage
              height below `md` (CONSTELLATION_STAGE_HEIGHT) is sized for its absence. */}
          <p className="mt-0.5 hidden max-w-xl text-sm text-muted-foreground md:block">
            You are the sun. Companies and schools form constellations around
            you — each figure traced by its own people.
          </p>
        </div>
        {/* Inside a saved view Top | All greys out in place: its members are explicit, not a filter. */}
        <div className="mb-0.5 flex min-w-0 items-center gap-1.5 md:shrink-0">
          <ConstellationViewsMenu tabs={tabs} activeId={activeId} canCreate={canCreate} />
          <ConstellationScopeToggle lockedCount={active?.memberCount} />
        </div>
      </div>
      {/*
        The intro sits OUTSIDE the boundary so it outlives every phase swap beneath it — the
        payload streaming, the chunk landing, and every canvas remount thereafter. Inside, it
        would be unmounted and restarted at each handover.

        The fallback is the bare canvas panel, not `GraphPageSkeleton`: the real <h1> above is
        outside the boundary and already painted, so the skeleton's own header bars used to
        render underneath it — a real heading and a grey fake one on screen together.
        `loading.tsx` still uses the full skeleton, where nothing has painted yet.
      */}
      {/*
        The wrapper paints the ground, not the chart's own stage.
        The intro sits BETWEEN the two states of this box — over the loading panel it covers,
        under the chart it hands over to — so the chart has to be transparent for it to show
        through from behind. Something has to hold the near-black, and the box that outlives
        both of them is the honest place for it. Same colour either way, so the handover when
        the stage takes its background back is not a step.
      */}
      <div className={`relative rounded-2xl ${STAGE_GROUND}`} {...tourAnchor("graph.stage")}>
        <ConstellationIntro />
        {/* Also outside the boundary: it covers the swap to a just-created view, and ends when
            that view's sky is on screen (generating-signal.ts). */}
        <ConstellationGenerating />
        {/* Keyed on the sky: a view switch shows the loading panel and remounts the chart, so one
            sky's layout, camera and search never leak into the next. */}
        <Suspense
          key={activeId ?? "all"}
          fallback={<ConstellationLoading className={CONSTELLATION_STAGE_HEIGHT} />}
        >
          <GraphIsland constellationId={activeId} />
        </Suspense>
      </div>
    </div>
  );
}

async function GraphIsland({ constellationId }: { constellationId: string | null }) {
  // Null also covers a sky deleted since the tab list was read: fall back to Everyone.
  const sky = constellationId ? await getConstellationGraphData(constellationId) : null;
  const initialData = sky ? sky.payload : await getGraphData();
  // NetworkGraph keeps the first payload it is given, so a sky whose members changed (added or
  // removed in the chart, then router.refresh) must remount to show them. The key carries a digest
  // of the drawn ids (order-independent): membership changes remount, a rename or an unrelated refresh does not.
  return (
    <NetworkGraphLazy
      key={sky ? `${sky.constellation.id}:${skyMembersDigest(sky.payload.c.id)}` : "all"}
      initialData={initialData}
      constellation={sky?.constellation}
    />
  );
}
