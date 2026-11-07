import { FeedbackTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminChatRatingsLoading() {
  return (
    <AdminLoading
      title="Feedback"
      tabs={<FeedbackTabs />}
      blocks={[{ tiles: 3 }, { tiles: 3 }, { panel: true, height: "h-64" }]}
    />
  );
}
