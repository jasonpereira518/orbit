import { AiFailuresPanel } from "@/components/admin/ops-panels";
import {
  AiOperationsPanel,
  AiVolumePanel,
  DataQualityPanel,
} from "@/components/admin/product-health-panels";
import { OpsShell } from "../_ops/ops-shell";
import { loadHealth } from "../_ops/data";

export const metadata = { title: "Admin · Ops · AI & data" };

/** Ops › AI & data: slow-moving volume and quality — AI failures, usage, data drift. */
export default async function AdminOpsAiPage() {
  const health = await loadHealth();
  return (
    <OpsShell>
      <div className="space-y-6">
        <AiFailuresPanel health={health} />
        <div className="grid gap-6 lg:grid-cols-2">
          <AiVolumePanel />
          <AiOperationsPanel />
        </div>
        <DataQualityPanel />
      </div>
    </OpsShell>
  );
}
