import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminGrowthLoading() {
  return (
    <>
      <AdminPageHeader title="Growth" subtitle="Bucketing history…" />
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel>
            <Skeleton className="h-40 w-full" />
          </AdminPanel>
          <AdminPanel>
            <Skeleton className="h-40 w-full" />
          </AdminPanel>
        </div>
        <AdminPanel>
          <Skeleton className="h-32 w-full" />
        </AdminPanel>
      </div>
    </>
  );
}
