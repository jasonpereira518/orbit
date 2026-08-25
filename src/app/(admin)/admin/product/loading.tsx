import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminProductLoading() {
  return (
    <>
      <AdminPageHeader title="Product" subtitle="Reading adoption and demand…" />
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
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
