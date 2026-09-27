import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminFeedbackDetailLoading() {
  return (
    <AdminLoading
      title="Feedback"
      blocks={[
        { panel: true, title: "What they said", height: "h-24" },
        { panel: true, title: "Screenshots", height: "h-40" },
        { panel: true, title: "Where they were", height: "h-16" },
        { panel: true, title: "Submitter", height: "h-20" },
        { panel: true, title: "Triage", height: "h-16" },
      ]}
    />
  );
}
