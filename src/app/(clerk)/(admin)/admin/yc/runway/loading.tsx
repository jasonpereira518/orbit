import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminRunwayLoading() {
  return (
    <AdminLoading
      title="Runway"
      blocks={[
        { tiles: 3 },
        { panel: true, title: "What burn is made of", height: "h-32" },
        { panel: true, title: "Update", height: "h-28" },
        { panel: true, title: "Recent expenses (30d)", height: "h-16" },
      ]}
    />
  );
}
