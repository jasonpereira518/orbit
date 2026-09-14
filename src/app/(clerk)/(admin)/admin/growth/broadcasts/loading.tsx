import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors /admin/growth/broadcasts: 3-up metric row + compose panel + sent-list panel. */
export default function AdminBroadcastsLoading() {
  return (
    <>
      <AdminPageHeader title="Broadcasts" subtitle="Loading audience…" />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <AdminPanel title="Compose" className="mb-6">
        <Skeleton className="h-32 w-full" />
      </AdminPanel>
      <AdminPanel title="Drafts and sent">
        <Skeleton className="h-40 w-full" />
      </AdminPanel>
    </>
  );
}
