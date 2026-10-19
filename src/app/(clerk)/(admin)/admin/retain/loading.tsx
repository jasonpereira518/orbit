import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminRetainLoading() {
  return (
    <AdminLoading
      title="Retain"
      subtitle="Reading the numbers…"
      blocks={[{ tiles: 4 }, { panel: true, title: "Retain", height: "h-40" }]}
    />
  );
}
