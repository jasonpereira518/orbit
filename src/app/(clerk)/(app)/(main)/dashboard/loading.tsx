import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import {
  DashboardCardSkeleton,
  DashboardStatRowSkeleton,
} from "@/components/loading/page-skeletons";

/**
 * The route-level fallback, shown on a client navigation into /dashboard before
 * the page's own streamed shell takes over.
 *
 * Every row below mirrors the SHAPE `page.tsx` renders — same wrapper (`flex`
 * where it flexes, `grid` where it grids), same gaps, same heights — so the
 * handoff from this file to the page's own Suspense fallbacks moves nothing.
 * The two had drifted: this file used `grid lg:grid-cols-2` for the charts and
 * suggested rows where the page uses `flex lg:flex-row`, which is a re-layout at
 * >=lg on every cold navigation.
 *
 * It cannot mirror the page exactly, and does not try: surface visibility is a
 * per-user database read that this file has no access to, so an account with
 * cards hidden sees skeletons here for rows that will not arrive. Shape parity
 * for the default case is the goal, not a pixel-perfect prediction.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      <DashboardHeader />

      <DashboardStatRowSkeleton />

      {/* Charts row — flex, matching page.tsx: the depth card removes itself on
          an empty network and the constellation preview then fills the row. */}
      <div className="flex flex-col gap-6 lg:flex-row">
        <DashboardCardSkeleton className="h-80 min-w-0 lg:flex-1" />
        <DashboardCardSkeleton className="h-80 min-w-0 lg:flex-1" />
      </div>

      {/* Suggested outreach + outreach performance — flex for the same reason. */}
      <div className="flex flex-col items-stretch gap-6 lg:flex-row">
        <DashboardCardSkeleton className="h-64 min-w-0 lg:flex-1" />
        <DashboardCardSkeleton className="h-64 min-w-0 lg:flex-1" />
      </div>

      {/* Reminders + Due follow-ups: one section, two cards, always a pair. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <DashboardCardSkeleton className="h-64" />
        <DashboardCardSkeleton className="h-64" />
      </div>

      {/* Recently updated owns a full-width row of its own. */}
      <DashboardCardSkeleton className="h-64" />

      {/* Tail: goals, orbit numbers, plan. */}
      <DashboardCardSkeleton className="h-64" />
    </div>
  );
}
