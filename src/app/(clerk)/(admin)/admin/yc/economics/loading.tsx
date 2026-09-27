import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminEconomicsLoading() {
  return (
    <AdminLoading
      title="Unit Economics"
      blocks={[{ tiles: 3 }, { panel: true, title: "Update", height: "h-28" }]}
    />
  );
}
