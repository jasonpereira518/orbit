import { AccessTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminBroadcastsLoading() {
  return (
    <AdminLoading
      title="Access"
      tabs={<AccessTabs />}
      blocks={[
        { tiles: 1 },
        { panel: true, title: "Compose", height: "h-96" },
        { panel: true, title: "Drafts and sent", height: "h-16" },
      ]}
    />
  );
}
