import { AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminContactLoading() {
  return (
    <>
      <Skeleton className="mb-3 h-4 w-28" />
      <div className="mb-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="space-y-6">
        <AdminPanel>
          <Skeleton className="h-24 w-full" />
        </AdminPanel>
        <AdminPanel>
          <Skeleton className="h-48 w-full" />
        </AdminPanel>
      </div>
    </>
  );
}
