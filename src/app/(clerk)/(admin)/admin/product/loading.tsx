import { AdminLoading } from "@/components/admin/loading-shells";
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

/** Mirrors /admin/product: header, the two preview cards, the tab row, then the page list. */
export default function AdminProductLoading() {
  return (
    <AdminLoading
      title="Product"
      subtitle="Loading surfaces…"
      blocks={[
        { panel: true, title: "Preview", body: <Skeleton className="h-10 w-full max-w-xl" /> },
        { panel: true, title: "Pages, in sidebar order", body: <ToggleRows count={8} /> },
      ]}
    />
  );
}
