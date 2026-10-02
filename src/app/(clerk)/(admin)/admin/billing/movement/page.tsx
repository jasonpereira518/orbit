import Link from "next/link";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  PlanBadge,
  RelativeTime,
  Td,
  Th,
  TrendTable,
} from "@/components/admin/primitives";
import { MoneyTabs } from "@/components/admin/money-tabs";
import { formatCents } from "@/lib/format-money";
import { ADMIN_AGGREGATES_TTL_MS, loadAdminUserRows } from "@/lib/admin-metrics";
import { PLAN_CONFIG } from "@/lib/plans/plan-config";
import { countLifetimePurchases } from "@/lib/user-settings";
import { compedForegoneCents, mrrMovementSeries } from "@/lib/money-metrics";

export const metadata = { title: "Admin · Money · Movement" };

const MONTH = new Intl.DateTimeFormat("en", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/**
 * Where the recurring number came from, broken into its parts.
 *
 * A table rather than a chart, deliberately: five signed dollar figures per month is
 * exactly the case `TrendTable` was written for, and printed integers read as "basically
 * nothing happened" where an autoscaled shape would read as a dramatic month.
 */
export default async function MoneyMovementPage() {
  const [movements, lifetimeSold, comps, rows] = await Promise.all([
    mrrMovementSeries("month", 6),
    countLifetimePurchases(),
    compedForegoneCents(),
    // Only user_settings columns are read here, and those are always live.
    loadAdminUserRows({ aggregatesMaxAgeMs: ADMIN_AGGREGATES_TTL_MS }),
  ]);

  const comped = rows.filter((r) => r.planSource === "comp");
  const totals = movements.reduce(
    (acc, m) => ({
      newCents: acc.newCents + m.newCents,
      reactivationCents: acc.reactivationCents + m.reactivationCents,
      churnCents: acc.churnCents + m.churnCents,
      oneTimeCents: acc.oneTimeCents + m.oneTimeCents,
    }),
    { newCents: 0, reactivationCents: 0, churnCents: 0, oneTimeCents: 0 }
  );

  return (
    <>
      <AdminPageHeader
        title="Movement"
        subtitle="Every change to recurring revenue, and the one-time sales beside it"
      />
      <MoneyTabs />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Gained, 6mo"
            value={formatCents(totals.newCents + totals.reactivationCents)}
            hint="new and returning"
          />
          <MetricTile
            label="Lost, 6mo"
            value={formatCents(Math.abs(totals.churnCents))}
            tone={totals.churnCents < 0 ? "danger" : "muted"}
            hint="churned"
          />
          <MetricTile
            label="One-time, 6mo"
            value={formatCents(totals.oneTimeCents)}
            hint="legacy Lifetime and credit packs"
          />
          <MetricTile
            label="Comped away"
            value={`${formatCents(comps.foregoneMonthlyCents)}/mo`}
            tone={comps.comped > 0 ? "accent" : "muted"}
            hint={`${comps.comped} accounts at list price`}
          />
        </div>

        <AdminPanel title="Recurring movement by month">
          <TrendTable
            columns={["New", "Return", "Expand", "Contract", "Churn", "Net"]}
            rows={movements.map((m) => ({
              period: MONTH.format(m.bucketStart),
              values: [
                Math.round(m.newCents / 100),
                Math.round(m.reactivationCents / 100),
                Math.round(m.expansionCents / 100),
                Math.round(m.contractionCents / 100),
                Math.round(m.churnCents / 100),
                Math.round(m.netCents / 100),
              ],
            }))}
          />
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Whole dollars per month. <strong>Contract</strong> counts a monthly subscriber
            moving to annual: $5/mo becomes $4.17/mo, so recurring revenue genuinely falls
            while cash goes up. Both are true, and the cash side is on the Costs tab.
          </p>
        </AdminPanel>

        <AdminPanel title="One-time sales">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile label="Lifetime sold" value={lifetimeSold} hint="before pricing v2; no longer on sale" />
          </div>
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Revenue is booked from what each buyer actually paid. Credit packs are one-time
            revenue too, never MRR.
          </p>
        </AdminPanel>

        <AdminPanel title="Comped accounts">
          {comped.length === 0 ? (
            <EmptyState>Nobody has been comped yet.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Account</Th>
                  <Th>Plan</Th>
                  <Th>Reason</Th>
                  <Th numeric>Granted</Th>
                  <Th numeric>Worth</Th>
                </>
              }
            >
              {comped.map((row) => (
                <tr key={row.userId} className="border-b border-border/40 last:border-b-0">
                  <Td>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.userId)}`}
                      className="hover:text-primary"
                    >
                      {row.email ?? row.userId}
                    </Link>
                  </Td>
                  <Td>
                    <PlanBadge plan={row.plan} source={row.planSource} />
                  </Td>
                  <Td className="max-w-xs truncate text-muted-foreground">
                    {row.compedNote ?? "—"}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.compedAt} />
                  </Td>
                  <Td numeric>
                    {row.plan === "orbit" || row.plan === "max"
                      ? `${formatCents(PLAN_CONFIG[row.plan].monthlyPriceCents ?? 0)}/mo`
                      : "—"}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Priced so the decision can be reviewed rather than merely accumulated. A comp
            is revenue chosen not to collect, which is a different thing from free.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
