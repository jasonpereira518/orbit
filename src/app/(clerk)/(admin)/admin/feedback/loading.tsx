import { FeedbackTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminFeedbackLoading() {
  return (
    <AdminLoading
      title="Feedback"
      subtitle="Loading feedback…"
      tabs={<FeedbackTabs />}
      blocks={[{ tiles: 2 }, { panel: true, height: "h-40" }, { panel: true, height: "h-64" }]}
    />
  );
}
