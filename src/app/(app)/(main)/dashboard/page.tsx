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

export default function DashboardPage() {
  // Start both fetches WITHOUT awaiting: the header and grid shell flush
  // immediately, and each Suspense section below awaits the shared promise
  // it needs. The bundle promise feeds every card from one network scan
  // (don't split it into per-card fetches); the outreach summary streams
  // independently.
  const bundle = fetchDashboard();
  const outreachSummary = getOutreachPerformanceSummary();

  return (
    <div className="flex flex-col gap-8">
      <DashboardHeader />

      <Suspense fallback={<DashboardStatRowSkeleton />}>
        <StatsSection bundle={bundle} />
      </Suspense>

      <div className="order-1 grid items-stretch gap-6 lg:order-3 lg:grid-cols-2">
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <SuggestedOutreachSection bundle={bundle} />
        </Suspense>
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <div className="hidden h-full lg:block">
            <OutreachPerformanceSection summary={outreachSummary} />
          </div>
        </Suspense>
      </div>

      <div className="order-2 grid items-start gap-6 lg:order-4 lg:grid-cols-2">
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
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <RecentlyUpdatedSection bundle={bundle} />
        </Suspense>
      </div>

      <div className="order-3 grid gap-6 lg:order-2 lg:grid-cols-2">
        <Suspense
          fallback={
            <>
              <DashboardCardSkeleton className="h-80" />
              <DashboardCardSkeleton className="h-80" />
            </>
          }
        >
          <ChartsSection bundle={bundle} />
        </Suspense>
      </div>

      <div className="order-4 lg:hidden">
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <OutreachPerformanceSection summary={outreachSummary} />
        </Suspense>
      </div>

      <div className="order-5 lg:order-5">
        <Suspense fallback={<DashboardCardSkeleton className="h-64" />}>
          <TailSection bundle={bundle} />
        </Suspense>
      </div>
    </div>
  );
}
