import { AdminPageHeader, AdminPanel } from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";

function ToggleRows({ count }: { count: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 py-1">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Mirrors /admin/product: header + Preview panel + three surface-toggle panels. */
export default function AdminProductLoading() {
  return (
    <>
      <AdminPageHeader title="Product" subtitle="Loading surfaces…" />
      <div className="space-y-6">
        <AdminPanel title="Preview">
          <Skeleton className="h-3 w-full max-w-md" />
        </AdminPanel>
        <AdminPanel title="Pages">
          <ToggleRows count={4} />
        </AdminPanel>
        <AdminPanel title="Dashboard cards">
          <ToggleRows count={3} />
        </AdminPanel>
        <AdminPanel title="Settings sections">
          <ToggleRows count={3} />
        </AdminPanel>
      </div>
    </>
  );
}
