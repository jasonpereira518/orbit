import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import {
  DashboardCardSkeleton,
  DashboardStatRowSkeleton,
} from "@/components/loading/page-skeletons";

/**
 * Mirrors page.tsx's streamed shell exactly (real header + same skeleton
 * slots) so client navigation hands off to the shell with identical pixels.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      <DashboardHeader />
      <DashboardStatRowSkeleton />
      <div className="grid gap-6 lg:grid-cols-2">
        <DashboardCardSkeleton className="h-80" />
        <DashboardCardSkeleton className="h-80" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <DashboardCardSkeleton className="h-64" />
        <DashboardCardSkeleton className="h-64" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <DashboardCardSkeleton className="h-64" />
        <DashboardCardSkeleton className="h-64" />
      </div>
      <DashboardCardSkeleton className="h-64" />
    </div>
  );
}
