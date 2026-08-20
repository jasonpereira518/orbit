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
    <div className="flex flex-col gap-8">
      <DashboardHeader />
      <DashboardStatRowSkeleton />
      <div className="order-1 grid gap-6 lg:order-3 lg:grid-cols-2">
        <DashboardCardSkeleton className="h-64" />
        <DashboardCardSkeleton className="hidden h-64 lg:block" />
      </div>
      <div className="order-2 grid gap-6 lg:order-4 lg:grid-cols-2">
        <DashboardCardSkeleton className="h-64" />
        <DashboardCardSkeleton className="h-64" />
      </div>
      <div className="order-3 grid gap-6 lg:order-2 lg:grid-cols-2">
        <DashboardCardSkeleton className="h-80" />
        <DashboardCardSkeleton className="h-80" />
      </div>
      <DashboardCardSkeleton className="order-4 h-64 lg:hidden" />
      <DashboardCardSkeleton className="order-5 h-64" />
    </div>
  );
}
