import { AdminPageHeader } from "@/components/admin/primitives";
import {
  LiveAlertsPanel,
  LiveKpiTiles,
  LiveRecentSignupsPanel,
  OverviewLiveProvider,
} from "@/components/admin/overview-live";
import { getInterestListSummary } from "@/lib/admin-interest-list";
import { buildPlanBreakdown, getOverviewLive } from "@/lib/admin-metrics";
import { formatCostMicros } from "@/lib/ai-pricing";
import { currentMrrCents } from "@/lib/billing-events";
import { managedAiUsage } from "@/lib/credits/admin-credits";
import { formatCents } from "@/lib/format-money";

export const metadata = { title: "Admin · Overview" };

/**
 * Triage, not summary.
 *
 * This screen answers "is anything on fire?" in about two seconds: who needs attention, who
 * just arrived, and six numbers that each link to the section that owns them. Everything
 * deeper — the activation funnel, money detail, the waitlist — lives in its own section.
 *
 * Absolute integers only: no percentages, no rates, no trend sparklines. One new
 * subscriber is +100% MRR growth, and a sparkline of 0,1,0,0,2,1,0 is noise rendered as a
 * shape.
 */
export default async function AdminOverviewPage() {
  const now = new Date();
  const [{ triage, ...initialLive }, mrrCents, waitlist, managed] = await Promise.all([
    getOverviewLive(),
    // Each KPI degrades on its own: a broken read prints "—", never 500s triage.
    currentMrrCents().catch(() => null),
    getInterestListSummary().catch(() => null),
    // Orbit's own AI bill (users' own keys are their bill, not shown here).
    managedAiUsage(30, now).catch(() => null),
  ]);

  const totalUsers = triage.rows.length;
  const plans = buildPlanBreakdown(triage.rows);
  const { alerts } = triage;

  return (
    <OverviewLiveProvider initial={initialLive}>
      <AdminPageHeader
        title="Overview"
        subtitle={
          <>
            <span className="tabular-nums">{totalUsers}</span> account
            {totalUsers === 1 ? "" : "s"} ·{" "}
            <span className="tabular-nums">{plans.paid}</span> paid ·{" "}
            <span className="tabular-nums">{plans.subscribed}</span> subscribed ·{" "}
            {alerts.length > 0 ? (
              <span className="text-foreground">
                <span className="tabular-nums">{alerts.length}</span> need
                {alerts.length === 1 ? "s" : ""} attention
              </span>
            ) : (
              "all healthy"
            )}
          </>
        }
      />

      <div className="space-y-6">
        <LiveAlertsPanel totalUsers={totalUsers} />
        <LiveRecentSignupsPanel totalUsers={totalUsers} />
        <LiveKpiTiles
          mrr={mrrCents == null ? "—" : formatCents(mrrCents)}
          waiting={waitlist?.active ?? null}
          aiManaged={formatCostMicros(managed?.costMicros) ?? "—"}
        />
      </div>
    </OverviewLiveProvider>
  );
}
