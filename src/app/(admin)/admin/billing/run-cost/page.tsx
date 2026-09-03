import Link from "next/link";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  MiniBars,
  Td,
  Th,
} from "@/components/admin/primitives";
import { MoneyTabs } from "@/components/admin/money-tabs";
import { DistributionChart } from "@/components/admin/charts";
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";
import { formatMicros } from "@/lib/format-money";
import { costToRunBreakdown, costToRunPerUser } from "@/lib/money-metrics";

export const metadata = { title: "Admin · Money · Cost to run" };

const MONTH = new Intl.DateTimeFormat("en", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/**
 * What Orbit costs the people who use it.
 *
 * NOT ORBIT'S MONEY. Production is strictly bring-your-own-key, so every figure here is
 * spend on a user's own provider account. It still belongs in the Money section, because
 * it is the number that decides whether BYOK stays viable: a product that quietly costs
 * its users more per month than it charges has a pricing problem it cannot see from the
 * revenue side.
 */
export default async function MoneyRunCostPage() {
  const [{ points, clamped }, breakdown] = await Promise.all([
    costToRunPerUser("month", 6),
    costToRunBreakdown(30),
  ]);

  const latest = points.at(-1);
  const totalMicros = points.reduce((sum, p) => sum + p.totalMicros, 0);

  return (
    <>
      <AdminPageHeader
        title="Cost to run"
        subtitle="What Orbit costs its users — their AI keys, not yours"
      />
      <MoneyTabs />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Median, this month"
            value={formatMicros(latest?.p50Micros ?? 0)}
            hint="per active account"
          />
          <MetricTile
            label="90th percentile"
            value={formatMicros(latest?.p90Micros ?? 0)}
            hint="the heavy tail starts here"
          />
          <MetricTile
            label="Heaviest account"
            value={formatMicros(latest?.maxMicros ?? 0)}
            tone={
              (latest?.maxMicros ?? 0) > (latest?.p50Micros ?? 0) * 10
                ? "accent"
                : "default"
            }
            hint="this month"
          />
          <MetricTile
            label="All accounts"
            value={formatMicros(totalMicros)}
            hint="across the window below"
          />
        </div>

        <AdminPanel title="Spend per account, by month">
          <DistributionChart
            points={points.map((p) => ({
              label: MONTH.format(p.bucketStart),
              activeUsers: p.activeUsers,
              p50: p.p50Micros,
              p90: p.p90Micros,
              max: p.maxMicros,
            }))}
          />
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            A spread, not an average. One account at fifty times the median is the whole
            story, and a mean reports it as a mild uptick.
            {clamped && (
              <>
                {" "}
                The window stops at {USAGE_EVENT_RETENTION_DAYS} days because the nightly
                job prunes older usage rows — months beyond that would render as real zeros
                and read as a decline in cost that is entirely the delete job.
              </>
            )}
          </p>
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="By model, 30 days">
            {breakdown.byModel.length === 0 ? (
              <EmptyState>No AI calls in the last 30 days.</EmptyState>
            ) : (
              <MiniBars
                rows={breakdown.byModel.map((row) => ({
                  label: row.label,
                  count: Math.round(row.micros / 10_000),
                }))}
              />
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Cents of estimated spend. Models missing from the price table report no cost
              at all rather than a confident zero, so a new model can make this understate.
            </p>
          </AdminPanel>

          <AdminPanel title="By operation, 30 days">
            {breakdown.byOperation.length === 0 ? (
              <EmptyState>No AI calls in the last 30 days.</EmptyState>
            ) : (
              <MiniBars
                rows={breakdown.byOperation.map((row) => ({
                  label: row.label,
                  count: Math.round(row.micros / 10_000),
                }))}
              />
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Which parts of the product are expensive to run. The costly call site is the
              one worth caching, not the frequent one.
            </p>
          </AdminPanel>
        </div>

        <AdminPanel title="Heaviest accounts, 30 days">
          {breakdown.topSpenders.length === 0 ? (
            <EmptyState>No AI usage recorded in the last 30 days.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Account</Th>
                  <Th numeric>Calls</Th>
                  <Th numeric>Their spend</Th>
                </>
              }
            >
              {breakdown.topSpenders.map((row) => (
                <tr key={row.userId} className="border-b border-border/40 last:border-b-0">
                  <Td>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.userId)}`}
                      className="hover:text-primary"
                    >
                      {row.userId}
                    </Link>
                  </Td>
                  <Td numeric>{row.calls}</Td>
                  <Td numeric>{formatMicros(row.micros)}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Charged to their own provider account, not to Orbit. Worth watching anyway:
            someone paying $5/mo and spending $40 on AI to use the product is a churn risk
            that never appears in the revenue figures.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
