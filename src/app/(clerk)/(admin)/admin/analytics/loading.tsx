import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminTrafficLoading() {
  return (
    <>
      <AdminPageHeader title="Traffic" subtitle="Counting page views…" />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
        <AdminPanel>
          <Skeleton className="h-40 w-full" />
        </AdminPanel>
        <AdminPanel>
          <Skeleton className="h-48 w-full" />
        </AdminPanel>
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel>
            <Skeleton className="h-32 w-full" />
          </AdminPanel>
          <AdminPanel>
            <Skeleton className="h-32 w-full" />
          </AdminPanel>
        </div>
      </div>
    </>
  );
}
