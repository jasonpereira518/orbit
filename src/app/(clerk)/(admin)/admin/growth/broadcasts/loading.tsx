import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminBroadcastsLoading() {
  return (
    <AdminLoading
      title="Broadcasts"
      blocks={[
        { tiles: 3 },
        { panel: true, title: "Compose", height: "h-96" },
        { panel: true, title: "Drafts and sent", height: "h-16" },
      ]}
    />
  );
}
