import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminRevenueLoading() {
  return (
    <AdminLoading
      title="Revenue"
      blocks={[{ tiles: 3 }, { panel: true, title: "MRR movement (30d)", height: "h-96" }]}
    />
  );
}
