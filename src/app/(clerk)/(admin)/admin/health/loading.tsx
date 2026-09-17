import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminHealthLoading() {
  return (
    <AdminLoading
      title="Health"
      subtitle="Checking every account…"
      blocks={[
        { panel: true, title: "Provider status", height: "h-40" },
        { panel: true, title: "Open alerts", height: "h-16" },
        { tiles: 4 },
        { panel: true, title: "Accounts that cannot use AI at all", height: "h-10" },
        { panel: true, title: "Failed and stalled imports", height: "h-16" },
      ]}
    />
  );
}
