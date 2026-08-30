import { AdminPageHeader, MetricTile } from "@/components/admin/primitives";
import { loadRevenueGrowth } from "@/lib/admin-yc-metrics";

export const metadata = { title: "Admin · Revenue" };

export default async function RevenuePage() {
  const { mrrUsd, subscriberGrowthPct, newSubscribers30d, newSubscribersPrior30d } =
    await loadRevenueGrowth();

  return (
    <>
      <AdminPageHeader
        title="Revenue"
        subtitle="MRR and subscriber growth — Orbit's one flat price makes new-subscriber count the honest growth signal, not a claimed dollar MRR delta."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile label="MRR" value={`$${mrrUsd.toLocaleString()}`} />
        <MetricTile
          label="Subscriber growth"
          value={subscriberGrowthPct === null ? "—" : `${subscriberGrowthPct >= 0 ? "+" : ""}${subscriberGrowthPct.toFixed(0)}%`}
          hint="new subscribers, 30d vs. prior 30d"
          tone={subscriberGrowthPct !== null && subscriberGrowthPct < 0 ? "danger" : "default"}
        />
        <MetricTile
          label="New subscribers (30d)"
          value={newSubscribers30d}
          hint={`${newSubscribersPrior30d} in the prior 30 days`}
        />
      </div>
    </>
  );
}
