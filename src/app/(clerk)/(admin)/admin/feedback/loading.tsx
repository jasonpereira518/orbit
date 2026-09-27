import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminFeedbackLoading() {
  return (
    <AdminLoading
      title="Feedback"
      subtitle="Loading feedback…"
      blocks={[{ tiles: 4 }, { panel: true, height: "h-64" }]}
    />
  );
}
