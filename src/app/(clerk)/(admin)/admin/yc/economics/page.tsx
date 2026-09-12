import { AdminPageHeader, AdminPanel, MetricTile } from "@/components/admin/primitives";
import {
  EstimatedChurnForm,
  LogAcquisitionSpendForm,
} from "@/components/admin/yc/economics-forms";
import { loadUnitEconomics } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Unit Economics" };

export default async function UnitEconomicsPage() {
  const { cac, ltv, ltvToCac, spend30dUsd, newSubscribers30d, estimatedMonthlyChurnPct } =
    await loadUnitEconomics();

  return (
    <>
      <AdminPageHeader
        title="Unit Economics"
        subtitle="CAC from logged acquisition spend; LTV from a manual churn estimate — Orbit's subscriber count is too small to derive churn reliably from history."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="CAC"
            value={cac === null ? "—" : `$${cac.toFixed(0)}`}
            hint={`$${spend30dUsd.toLocaleString()} / ${newSubscribers30d} new`}
          />
          <MetricTile label="LTV" value={ltv === null ? "—" : `$${ltv.toFixed(0)}`} />
          <MetricTile
            label="LTV : CAC"
            value={ltvToCac === null ? "—" : `${ltvToCac.toFixed(1)}x`}
            tone={ltvToCac !== null && ltvToCac < 3 ? "danger" : "default"}
          />
        </div>

        <AdminPanel title="Update">
          <div className="space-y-4">
            <EstimatedChurnForm currentPct={estimatedMonthlyChurnPct} />
            <LogAcquisitionSpendForm />
          </div>
        </AdminPanel>
      </div>
    </>
  );
}
