import { OpsTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminOpsAiLoading() {
  return (
    <AdminLoading
      title="Ops"
      subtitle="Reading AI usage…"
      tabs={<OpsTabs />}
      blocks={[
        { panel: true, title: "AI failures", height: "h-24" },
        {
          pair: [
            { title: "AI calls by week", height: "h-40" },
            { title: "AI operations used", height: "h-40" },
          ],
        },
        { panel: true, title: "Data quality", height: "h-40" },
      ]}
    />
  );
}
