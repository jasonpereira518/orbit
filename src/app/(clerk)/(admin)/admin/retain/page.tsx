import Link from "next/link";
import { AdminPageHeader, AdminPanel, AdminTable, EmptyState, MetricTile, Td, Th } from "@/components/admin/primitives";
import { retentionCurves } from "@/lib/admin-trends";
import { formatRate } from "@/lib/format-rate";
import { churnSummary, retentionPools, weeklyActiveNetworkers } from "@/lib/product-metrics";

export const metadata = { title: "Admin · Retain" };
export const dynamic = "force-dynamic";

const MIN_SUBSCRIBERS_FOR_CHURN_RATE = 100;

/**
 * Steady state: do people stay, and does it pay. Retention by signup month, the pools a season
 * leaves behind, churn, and a pointer to the money pages for margin and lifetime value.
 *
 * No job-seeker cut: Orbit records no goal type, so a seasonal user cannot be told from a
 * lapsed one by anything but silence. The "going cold" pool is the honest stand-in; a stated
 * goal at onboarding is the fix.
 */
export default async function AdminRetainPage() {
  const now = new Date();
  const [curves, pools, churn, wan] = await Promise.all([
    retentionCurves(6, 12),
    retentionPools(now),
    churnSummary(now),
    weeklyActiveNetworkers(now),
  ]);
  const showChurnRate = churn.subscribersNow >= MIN_SUBSCRIBERS_FOR_CHURN_RATE;
  const weeks = Array.from({ length: 12 }, (_, i) => i);

  return (
    <>
      <AdminPageHeader title="Retain" subtitle="Retention, the pools a season leaves behind, and churn." />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Active this month" value={wan.mau} hint={`${wan.current} in the last 7 days`} />
        <MetricTile label="Came back" value={pools.resurrected} hint="active this week after four quiet weeks" />
        <MetricTile label="Going cold" value={pools.goingCold} hint="last active 3 to 8 weeks ago · a pool, not churn" />
        <MetricTile label="Dormant" value={pools.dormant} hint={`quiet 8+ weeks, of ${pools.everActive} who ever used it`} />
      </div>

      <AdminPanel title="Retention by signup month">
        {curves.every((c) => c.size === 0) ? (
          <EmptyState>No sign-ups in the last six months.</EmptyState>
        ) : (
          <AdminTable
            label="Retention by signup month"
            minWidth="lg"
            head={
              <>
                <Th>Joined</Th>
                <Th numeric>Accounts</Th>
                {weeks.map((w) => (
                  <Th key={w} numeric>
                    {w === 0 ? "Wk 0" : `Wk ${w}`}
                  </Th>
                ))}
              </>
            }
          >
            {curves
              .filter((c) => c.size > 0)
              .map((c) => (
                <tr key={c.cohortStart.toISOString()} className="border-b border-border/40 last:border-b-0">
                  <Td className="tabular-nums">{c.cohortStart.toISOString().slice(0, 7)}</Td>
                  <Td numeric>{c.size}</Td>
                  {weeks.map((w) => {
                    const point = c.weeks.find((p) => p.week === w);
                    return (
                      <Td key={w} numeric className={point ? undefined : "text-muted-foreground/40"}>
                        {point ? formatRate(point.active, c.size) : "·"}
                      </Td>
                    );
                  })}
                </tr>
              ))}
          </AdminTable>
        )}
        <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
          A week is drawn only once every account in the cohort has lived through it. “Active” means a deliberate action, as
          everywhere else; calendar syncs and background AI calls do not count.
        </p>
      </AdminPanel>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <AdminPanel title="Churn">
          <p className="py-1 text-sm">
            <span className="text-2xl tabular-nums">{churn.canceledLast90d}</span>{" "}
            <span className="text-muted-foreground">
              subscription{churn.canceledLast90d === 1 ? "" : "s"} ended in 90 days · {churn.subscribersNow} paying now
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {showChurnRate
              ? `${formatRate(churn.canceledLast90d, churn.subscribersNow + churn.canceledLast90d)} of the base at the start of the window.`
              : `A churn rate is withheld below ${MIN_SUBSCRIBERS_FOR_CHURN_RATE} subscribers: one cancellation is a double-digit swing, and the lifetime-value figure that leans on it would be a guess.`}{" "}
            Comped accounts are not subscribers.
          </p>
        </AdminPanel>

        <AdminPanel title="Margin and lifetime value">
          <p className="py-1 text-sm text-muted-foreground">
            Gross margin by plan, the accounts that cost more than they pay, CAC and payback live with the money pages.
          </p>
          <div className="flex gap-4 text-sm">
            <Link href="/admin/billing/costs" className="underline underline-offset-2 hover:text-primary">
              Costs and margin
            </Link>
            <Link href="/admin/yc/economics" className="underline underline-offset-2 hover:text-primary">
              Unit economics
            </Link>
          </div>
        </AdminPanel>
      </div>
    </>
  );
}
