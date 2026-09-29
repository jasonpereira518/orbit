import { Suspense } from "react";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { NetworkStatsCard } from "@/components/dashboard/network-stats-card";
import { RenderStamp } from "@/components/layout/render-stamp";
import { RadarPageSkeleton } from "@/components/loading/page-skeletons";
import { RadarHeader } from "@/components/radar/radar-header";
import { RadarView } from "@/components/radar/radar-view";
import { fetchRadar } from "@/actions/radar";

async function RadarBody() {
  const { page, networkStats } = await fetchRadar();
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <RadarView
        recommendations={page.recommendations.map((r) => ({
          id: r.id,
          contactId: r.contactId,
          kind: r.kind,
          reasons: r.reasons,
          evidence: r.evidence,
          aiNote: r.aiNote,
          contactName: r.contactName,
          title: r.title,
          company: r.company,
          tier: r.tier,
          avatarUrl: r.avatarUrl,
        }))}
        lastRunAt={page.lastRunAt ? page.lastRunAt.toISOString() : null}
        paused={page.paused}
        aiAvailable={page.aiAvailable}
        hasContacts={page.hasContacts}
      />
      {networkStats && (
        <aside className="min-w-0">
          <NetworkStatsCard stats={networkStats} />
        </aside>
      )}
    </div>
  );
}

export default async function RadarPage() {
  // The gate first, and only then any load: a viewer who sees "Coming soon" must not
  // trigger a first build. See `pageVisibilityGate` for why the page re-checks itself.
  const gate = await pageVisibilityGate("page.radar");
  if (gate) return gate;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <RenderStamp />
      <RadarHeader />
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <Suspense fallback={<RadarPageSkeleton />}>
          <RadarBody />
        </Suspense>
      </div>
    </div>
  );
}
