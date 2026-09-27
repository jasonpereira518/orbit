import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminOverviewLoading() {
  return (
    <AdminLoading
      title="Overview"
      subtitle="Counting accounts…"
      blocks={[
        { panel: true, title: "Needs attention", height: "h-10" },
        {
          pair: [
            { title: "Activation", height: "h-44" },
            { title: "Signed up recently", height: "h-44" },
          ],
        },
        { panel: true, title: "Money", height: "h-24" },
      ]}
    />
  );
}
