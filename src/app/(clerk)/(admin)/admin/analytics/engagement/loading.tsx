import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminEngagementLoading() {
  return (
    <>
      <AdminPageHeader title="Engagement" subtitle="Reading what accounts did…" />
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
        <AdminPanel>
          <Skeleton className="h-32 w-full" />
        </AdminPanel>
        <AdminPanel>
          <Skeleton className="h-32 w-full" />
        </AdminPanel>
        <AdminPanel>
          <Skeleton className="h-24 w-full" />
        </AdminPanel>
      </div>
    </>
  );
}
