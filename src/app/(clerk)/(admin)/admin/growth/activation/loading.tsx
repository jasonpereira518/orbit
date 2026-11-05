import { AdminLoading } from "@/components/admin/loading-shells";
import { GrowthTabs } from "@/components/admin/admin-tabs";

export default function AdminActivationLoading() {
  return (
    <AdminLoading
      title="Growth"
      subtitle="Reading the numbers…"
      tabs={<GrowthTabs />}
      blocks={[
        { range: true },
        { tiles: 2 },
        { panel: true, title: "Activation by signup cohort", height: "h-48" },
        { panel: true, title: "Invite waves", height: "h-40" },
        {
          pair: [
            { title: "Activation by onboarding path · last 28 days", height: "h-32" },
            { title: "The first cliff", height: "h-32" },
          ],
        },
      ]}
    />
  );
}
