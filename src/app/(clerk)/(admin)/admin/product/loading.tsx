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

/** Mirrors /admin/product: header, preview, the constellation filter, then the toggle panels. */
export default function AdminProductLoading() {
  return (
    <AdminLoading
      title="Product"
      subtitle="Loading surfaces…"
      blocks={[
        { panel: true, title: "Preview", body: <Skeleton className="h-3 w-full max-w-md" /> },
        { panel: true, title: "Constellation", height: "h-44" },
        { panel: true, title: "Pages", body: <ToggleRows count={4} /> },
        { panel: true, title: "Dashboard cards", body: <ToggleRows count={3} /> },
        { panel: true, title: "Widgets", body: <ToggleRows count={1} /> },
        { panel: true, title: "Settings sections", body: <ToggleRows count={3} /> },
      ]}
    />
  );
}
