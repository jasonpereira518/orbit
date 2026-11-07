import { OpsTabs } from "@/components/admin/admin-tabs";
import { AdminLoading } from "@/components/admin/loading-shells";

export default function AdminOpsSystemsLoading() {
  return (
    <AdminLoading
      title="Ops"
      subtitle="Checking Orbit's systems…"
      tabs={<OpsTabs />}
      blocks={[
        { panel: true, height: "h-6" },
        { panel: true, title: "Provider status", height: "h-40" },
        { panel: true, title: "Nightly job", height: "h-24" },
        {
          pair: [
            { title: "Failures that used to vanish", height: "h-32" },
            { title: "Inbound webhooks (7 days)", height: "h-32" },
          ],
        },
      ]}
    />
  );
}
