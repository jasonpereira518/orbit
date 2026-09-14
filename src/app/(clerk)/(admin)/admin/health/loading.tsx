import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminHealthLoading() {
  return (
    <>
      <AdminPageHeader title="Health" subtitle="Checking every account…" />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <AdminPanel key={i}>
            <Skeleton className="h-24 w-full" />
          </AdminPanel>
        ))}
      </div>
    </>
  );
}
