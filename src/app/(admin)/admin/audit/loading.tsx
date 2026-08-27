import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminAuditLoading() {
  return (
    <>
      <AdminPageHeader title="Audit" subtitle="Reading the trail…" />
      <AdminPanel>
        <Skeleton className="h-64 w-full" />
      </AdminPanel>
    </>
  );
}
