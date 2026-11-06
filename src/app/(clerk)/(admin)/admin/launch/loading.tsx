import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminLaunchLoading() {
  return (
    <AdminLoading
      title="Launch"
      subtitle="Reading the numbers…"
      blocks={[{ tiles: 4 }, { panel: true, title: "Launch", height: "h-40" }]}
    />
  );
}
