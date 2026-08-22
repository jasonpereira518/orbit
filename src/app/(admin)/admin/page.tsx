import Link from "next/link";
import { AlertTriangle, CircleAlert, Sparkles } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  EmptyState,
  MetricTile,
  MiniBars,
  PlanBadge,
  RelativeTime,
} from "@/components/admin/primitives";
import { getAdminOverview } from "@/lib/admin-metrics";
import { formatCostMicros } from "@/lib/ai-pricing";
import { LIFETIME_SEAT_LIMIT } from "@/lib/plan-limits";
import { countLifetimePurchases } from "@/lib/user-settings";
import { cn } from "@/lib/utils";

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

  const { plans, alerts, funnel, rows } = overview;
  const recent = rows.slice(0, 6);
  const totalCost = rows.reduce((acc, r) => acc + r.estimatedCostMicros, 0);

  return (
    <>
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
        <AdminPanel title="Needs attention">
          {alerts.length === 0 ? (
            <EmptyState>
              Nothing needs you. {overview.totalUsers} account
              {overview.totalUsers === 1 ? "" : "s"}, all healthy.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/50">
              {alerts.map((alert, i) => (
                <li key={`${alert.userId}-${i}`}>
                  <Link
                    href={`/admin/users/${encodeURIComponent(alert.userId)}`}
                    className="flex items-center gap-3 py-2 transition-colors duration-fast hover:text-primary"
                  >
                    {alert.severity === "warn" ? (
                      <AlertTriangle
                        className="size-3.5 shrink-0 text-destructive"
                        aria-hidden
                      />
                    ) : (
                      <Sparkles
                        className="size-3.5 shrink-0 text-accent-foreground"
                        aria-hidden
                      />
                    )}
                    <span className="w-56 shrink-0 truncate">
                      {alert.email ?? alert.userId}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {alert.message}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Activation">
            <MiniBars rows={funnel.map((s) => ({ label: s.label, count: s.count }))} />
            <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground tabular-nums">
              {overview.signups.current} new in the last 30 days (
              {overview.signups.previous} in the 30 before) ·{" "}
              {overview.activeLast7d} active this week
            </p>
          </AdminPanel>

          <AdminPanel
            title="Signed up recently"
            action={
              <Link
                href="/admin/users"
                className="text-xs text-muted-foreground hover:text-primary"
              >
                All {overview.totalUsers} →
              </Link>
            }
          >
            {recent.length === 0 ? (
              <EmptyState>No accounts yet.</EmptyState>
            ) : (
              <ul className="divide-y divide-border/50">
                {recent.map((row) => (
                  <li key={row.userId}>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.userId)}`}
                      className="flex items-center gap-3 py-2 transition-colors duration-fast hover:text-primary"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {row.email ?? row.userId}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <RelativeTime date={row.signupAt} />
                      </span>
                      <PlanBadge plan={row.plan} source={row.planSource} />
                      <span
                        className={cn(
                          "w-20 shrink-0 text-right text-xs tabular-nums",
                          row.counts.contacts === 0 && "text-muted-foreground"
                        )}
                      >
                        {row.counts.contacts} · {row.counts.interactions}
                      </span>
                      {!row.hasProviderKey && (
                        <CircleAlert
                          className="size-3.5 shrink-0 text-destructive"
                          aria-label="No AI key configured"
                        />
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </AdminPanel>
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
              hint={`${Math.max(0, LIFETIME_SEAT_LIMIT - lifetimeSold)} of ${LIFETIME_SEAT_LIMIT} seats left`}
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
    </>
  );
}
