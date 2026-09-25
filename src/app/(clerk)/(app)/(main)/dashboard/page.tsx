import { Suspense } from "react";
import { getOutreachPerformanceSummary } from "@/actions/outreach";
import { fetchDashboard } from "@/actions/reminders";
import { AgentDraftsCard } from "@/components/dashboard/agent-drafts-card";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import {
  ChartsSection,
  OutreachPerformanceSection,
  RecentlyUpdatedSection,
  RemindersAndFollowUpsSection,
  StatsSection,
  SuggestedOutreachSection,
  TailSection,
} from "@/components/dashboard/dashboard-sections";
import {
  DashboardCardSkeleton,
  DashboardStatRowSkeleton,
} from "@/components/loading/page-skeletons";
import { listPendingAgentSends } from "@/lib/agent-sends";
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";

async function AgentDraftsSection() {
  const drafts = await listPendingAgentSends(await requireUserId());
  return <AgentDraftsCard drafts={drafts} />;
}

export default async function DashboardPage() {
  // Start the bundle BEFORE the visibility await below. That await is free on a full page
  // load (the layouts resolved it on the same request), but a sidebar click skips the
  // shared layouts, so there it is real round trips — and awaiting it first put them in
  // front of the dashboard's own queries. The bundle feeds every card from one network
  // scan (don't split it into per-card fetches); each Suspense section awaits it.
  const bundle = fetchDashboard();
  // Unhandled until a section awaits it; an early rejection must not crash the render.
  bundle.catch(() => {});

  const { hidden } = await resolveSurfaceVisibility(await requireUserId());
  const show = (key: string) => !hidden.has(key);

  // The outreach summary streams independently, and is not started at all when its card
  // is hidden — it is the one query on this page that no other card shares.
  const outreachSummary = show("dashboard.outreach-performance")
    ? getOutreachPerformanceSummary()
    : null;

  // Each row is guarded as well as each card: a `grid` whose children are all hidden still
  // renders, and its `gap` would leave an unexplained band of empty page behind.
  const showSuggestedRow = show("dashboard.suggested-outreach") || outreachSummary;

  return (
    <div className="space-y-8">
      <DashboardHeader />

      {/* Above every other card, and outside the surface-visibility switches: a message
          waiting to go out is the only thing on this page that needs a decision rather
          than attention, and it expires. It renders nothing when there is none. */}
      <Suspense fallback={null}>
        <AgentDraftsSection />
      </Suspense>

      {show("dashboard.stats") && (
        <Suspense fallback={<DashboardStatRowSkeleton />}>
          <StatsSection bundle={bundle} />
        </Suspense>
      )}

      {/* Flex for the same reason as the row below: the Network depth card removes itself
          on an empty network (it can only draw zeros), and the constellation preview
          should then fill the row rather than sit beside an empty grid column. */}
      {show("dashboard.charts") && (
        <div className="flex flex-col gap-6 lg:flex-row">
          <Suspense
            fallback={
              <>
                <DashboardCardSkeleton className="h-80 min-w-0 lg:flex-1" />
                <DashboardCardSkeleton className="h-80 min-w-0 lg:flex-1" />
              </>
            }
          >
            <ChartsSection bundle={bundle} />
          </Suspense>
        </div>
      )}

      {/* Flex, not a 2-column grid: the outreach card removes itself when the account has
          never sent anything (see OutreachPerformanceSection), and a grid would leave its
          empty column behind, stranding Suggested outreach at half width next to a hole.
          A Suspense boundary renders no DOM node, so with flex the survivor just fills. */}
      {showSuggestedRow && (
        <div className="flex flex-col items-stretch gap-6 lg:flex-row">
          {show("dashboard.suggested-outreach") && (
            <Suspense
              fallback={<DashboardCardSkeleton className="h-64 min-w-0 lg:flex-1" />}
            >
              <SuggestedOutreachSection bundle={bundle} />
            </Suspense>
          )}
          {outreachSummary && (
            <Suspense
              fallback={<DashboardCardSkeleton className="h-64 min-w-0 lg:flex-1" />}
            >
              <OutreachPerformanceSection summary={outreachSummary} />
            </Suspense>
          )}
        </div>
      )}

      {/* One section, TWO cards — so this grid always holds exactly two children,
          and `dashboard.reminders` hides both together. Recently updated used to
          share this row, which put THREE children in a two-column grid and left a
          visible empty cell beside the third; hiding Reminders left the same hole
          on the other side. It owns the row below instead, where its own column
          count can adapt. Stretched, like every other two-card row here: the two cards
          end on one line, and the shorter one's footer drops to meet it. */}
      {show("dashboard.reminders") && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Suspense
            fallback={
              <>
                <DashboardCardSkeleton className="h-64" />
                <DashboardCardSkeleton className="h-64" />
              </>
            }
          >
            <RemindersAndFollowUpsSection bundle={bundle} />
          </Suspense>
        </div>
      )}

      {show("dashboard.recently-updated") && (
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <RecentlyUpdatedSection bundle={bundle} />
        </Suspense>
      )}

      {show("dashboard.tail") && (
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <TailSection bundle={bundle} />
        </Suspense>
      )}
    </div>
  );
}
