import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminGrowthLoading() {
  return (
    <AdminLoading
      title="Growth"
      subtitle="Bucketing history…"
      blocks={[
        { range: true },
        {
          pair: [
            { title: "Signups by week", height: "h-64" },
            { title: "Accounts writing, by week", height: "h-64" },
          ],
        },
        { panel: true, title: "Activation by signup cohort", height: "h-96" },
        { panel: true, title: "Did each month's intake stick?", height: "h-56" },
      ]}
    />
  );
}
