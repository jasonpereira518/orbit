import { Suspense } from "react";
import { getOutreachPerformanceSummary } from "@/actions/outreach";
import { fetchDashboard } from "@/actions/reminders";
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
import { requireUserId } from "@/lib/auth";
import { resolveSurfaceVisibility } from "@/lib/surface-visibility";

export default async function DashboardPage() {
  // Awaiting here does NOT cost the streaming start below. Both layouts above already
  // resolved this on the same request and `getHiddenSurfaceKeys` is `cache()`d, so this
  // await settles on an already-resolved promise rather than issuing a query.
  const { hidden } = await resolveSurfaceVisibility(await requireUserId());
  const show = (key: string) => !hidden.has(key);

  // Start the fetches WITHOUT awaiting: the header and grid shell flush
  // immediately, and each Suspense section below awaits the shared promise
  // it needs. The bundle promise feeds every card from one network scan
  // (don't split it into per-card fetches); the outreach summary streams
  // independently, and is not started at all when its card is hidden — it is
  // the one query on this page that no other card shares.
  const bundle = fetchDashboard();
  const outreachSummary = show("dashboard.outreach-performance")
    ? getOutreachPerformanceSummary()
    : null;

  // Each row is guarded as well as each card: a `grid` whose children are all hidden still
  // renders, and its `gap` would leave an unexplained band of empty page behind.
  const showSuggestedRow = show("dashboard.suggested-outreach") || outreachSummary;
  const showRemindersRow =
    show("dashboard.reminders") || show("dashboard.recently-updated");

  return (
    <div className="space-y-8">
      <DashboardHeader />

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

      {showRemindersRow && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          {show("dashboard.reminders") && (
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
          )}
          {show("dashboard.recently-updated") && (
            <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
              <RecentlyUpdatedSection bundle={bundle} />
            </Suspense>
          )}
        </div>
      )}

      {show("dashboard.tail") && (
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <TailSection bundle={bundle} />
        </Suspense>
      )}
    </div>
  );
}
