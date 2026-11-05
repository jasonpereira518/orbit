import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminOverviewLoading() {
  return (
    <AdminLoading
      title="Overview"
      subtitle="Counting accounts…"
      blocks={[
        { panel: true, title: "Needs attention", height: "h-10" },
        { panel: true, title: "Signed up recently", height: "h-44" },
        { tiles: 4 },
      ]}
    />
  );
}
