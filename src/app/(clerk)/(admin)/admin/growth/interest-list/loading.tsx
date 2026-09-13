import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors /admin/growth/interest-list: 4-up metrics + trend/source panels + roster table. */
export default function AdminInterestListLoading() {
  return (
    <>
      <AdminPageHeader title="Interest list" subtitle="Loading signups…" />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <AdminPanel title="Signups by week">
          <Skeleton className="h-32 w-full" />
        </AdminPanel>
        <AdminPanel title="Where they come from">
          <Skeleton className="h-32 w-full" />
        </AdminPanel>
      </div>
      <AdminPanel>
        <Skeleton className="h-64 w-full" />
      </AdminPanel>
    </>
  );
}
