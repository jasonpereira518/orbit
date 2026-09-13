import Link from "next/link";
import { AdminPageHeader, AdminPanel, MetricTile } from "@/components/admin/primitives";
import {
  LiveActivationPanel,
  LiveAlertsPanel,
  LiveRecentSignupsPanel,
  OverviewLiveProvider,
  type OverviewLiveData,
} from "@/components/admin/overview-live";
import { getAdminOverview } from "@/lib/admin-metrics";
import { formatCostMicros } from "@/lib/ai-pricing";
import { countLifetimePurchases } from "@/lib/user-settings";

export const metadata = { title: "Admin · Overview" };

/**
 * Triage, not summary.
 *
 * At Orbit's scale the roster *is* the dashboard — every aggregate here is also directly
 * countable from the user list. So this screen's job is to answer "is anything on fire?"
 * in about two seconds, and everything else is secondary.
 *
 * Absolute integers only: no percentages, no rates, no trend sparklines. One new
 * subscriber is +100% MRR growth, and a sparkline of 0,1,0,0,2,1,0 is noise rendered as a
 * shape. Vanity totals (contacts across all accounts) are deliberately absent too — they
 * change no decision.
 */
export default async function AdminOverviewPage() {
  const [overview, lifetimeSold] = await Promise.all([
    getAdminOverview(),
    countLifetimePurchases().catch(() => 0),
  ]);

  const { plans, alerts, rows } = overview;
  const totalCost = rows.reduce((acc, r) => acc + r.estimatedCostMicros, 0);

  const initialLive: OverviewLiveData = {
    alerts: overview.alerts,
    funnel: overview.funnel,
    recent: rows.slice(0, 6).map((r) => ({
      userId: r.userId,
      email: r.email,
      signupAt: r.signupAt.toISOString(),
      plan: r.plan,
      planSource: r.planSource,
      counts: { contacts: r.counts.contacts, interactions: r.counts.interactions },
      hasProviderKey: r.hasProviderKey,
    })),
    signups: overview.signups,
    activeLast7d: overview.activeLast7d,
  };

  return (
    <OverviewLiveProvider initial={initialLive}>
      <AdminPageHeader
        title="Overview"
        subtitle={
          <>
            <span className="tabular-nums">{overview.totalUsers}</span> account
            {overview.totalUsers === 1 ? "" : "s"} ·{" "}
            <span className="tabular-nums">{plans.paidTotal}</span> paid ·{" "}
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
        <LiveAlertsPanel totalUsers={overview.totalUsers} />

        <div className="grid gap-6 lg:grid-cols-2">
          <LiveActivationPanel />
          <LiveRecentSignupsPanel totalUsers={overview.totalUsers} />
        </div>

        <AdminPanel
          title="Money"
          action={
            <Link
              href="/admin/billing"
              className="text-xs text-muted-foreground hover:text-primary"
            >
              Full detail →
            </Link>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Subscribed"
              value={plans.subscribed}
              hint="Orbit Pro, recurring"
            />
            <MetricTile
              label="Lifetime sold"
              value={lifetimeSold}
              hint="one-time purchases"
            />
            <MetricTile
              label="Comped"
              value={plans.comped}
              tone="accent"
              hint="granted by hand"
            />
            <MetricTile
              label="AI spend (BYOK)"
              value={formatCostMicros(totalCost) ?? "—"}
              tone="muted"
              hint="on users' own keys"
            />
          </div>
        </AdminPanel>
      </div>
    </OverviewLiveProvider>
  );
}
