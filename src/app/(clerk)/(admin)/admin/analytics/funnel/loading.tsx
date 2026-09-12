import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminFunnelLoading() {
  return (
    <>
      <AdminPageHeader title="Conversion" subtitle="Assembling the funnel…" />
      <div className="space-y-6">
        <AdminPanel>
          <Skeleton className="h-56 w-full" />
        </AdminPanel>
        <AdminPanel>
          <Skeleton className="h-32 w-full" />
        </AdminPanel>
      </div>
    </>
  );
}
