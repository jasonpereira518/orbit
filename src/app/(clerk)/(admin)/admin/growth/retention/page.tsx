import {
  AdminPageHeader,
  AdminPanel,
  MetricTile,
} from "@/components/admin/primitives";
import { GrowthTabs } from "@/components/admin/admin-tabs";
import { TimeSeriesChart, type ChartSeries } from "@/components/admin/growth-charts";
import {
  firstSignupAt,
  growthSnapshot,
  retentionCurves,
  rollingActiveTrend,
  userTotalsTrend,
  type Grain,
} from "@/lib/admin-trends";
import { formatRate } from "@/lib/format-rate";
import {
  RANGE_LABEL,
  longLabel,
  monthLabel,
  resolveGrowthWindow,
  shortLabel,
} from "@/lib/growth-range";
import { churnSummary, retentionPools, weeklyActiveNetworkers } from "@/lib/product-metrics";
import { GrowthWindowNav } from "../range-nav";

export const metadata = { title: "Admin · Growth · Retention" };

/** Retention looks at the last six monthly cohorts, twelve weeks out, whatever the range. */
const RETENTION_COHORTS = 6;
const RETENTION_WEEKS = 12;

const MIN_SUBSCRIBERS_FOR_CHURN_RATE = 100;

const BUCKET_HEADING: Record<Grain, string> = { day: "Day", week: "Week", month: "Month" };

/**
 * Retention: how many accounts there are, whether they keep doing things, and who leaves.
 *
 * "Active" means a deliberate write — a contact, note, chat, import or AI call — as everywhere
 * else in the console. Signed-in page views ("who showed up and read") live with traffic on
 * Acquisition; this tab counts people who acted.
 *
 * Counts, not rates, everywhere a number is printed — axes, tiles, tables. A percentage
 * appears only in a chart's readout, beside its fraction, and only past
 * `MIN_RATE_DENOMINATOR`. See `admin-trends.ts` for why the house rule bends that far and
 * no further.
 *
 * The pools (came back, going cold, dormant) are the honest stand-in for a job-seeker cut:
 * Orbit records no goal type, so a seasonal user cannot be told from a lapsed one by anything
 * but silence.
 *
 * The window is `?range=` and `?grain=` in the URL, so a view can be linked and the page
 * stays a server component; the charts are client islands that only draw what they're given.
 */
export default async function AdminRetentionPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; grain?: string }>;
}) {
  const params = await searchParams;
  const first = await firstSignupAt().catch(() => null);
  const { range, grain, buckets, spanDays } = resolveGrowthWindow(params, first);

  const now = new Date();
  const [snapshot, totals, rolling, curves, pools, churn, wan] = await Promise.all([
    growthSnapshot(spanDays),
    userTotalsTrend(grain, buckets),
    rollingActiveTrend(grain, buckets),
    retentionCurves(RETENTION_COHORTS, RETENTION_WEEKS),
    retentionPools(now),
    churnSummary(now),
    weeklyActiveNetworkers(now),
  ]);
  const showChurnRate = churn.subscribersNow >= MIN_SUBSCRIBERS_FOR_CHURN_RATE;

  const labels = totals.map((p) => shortLabel(p.bucketStart, grain));
  const titles = totals.map((p) => longLabel(p.bucketStart, grain));
  const per = grain === "day" ? "day" : grain;

  const spanText = range === "all" ? "since launch" : `in the last ${RANGE_LABEL[range]}`;
  const beforeText = range === "all" ? null : `${snapshot.newPrev} the ${RANGE_LABEL[range]} before`;

  // Retention: one series per cohort that has anyone in it, null where a week has not been
  // lived through by every member yet (a gap, never a zero).
  const retentionSeries: ChartSeries[] = curves
    .filter((c) => c.size > 0)
    .map((c) => {
      const values: Array<number | null> = Array.from({ length: RETENTION_WEEKS + 1 }, () => null);
      for (const w of c.weeks) values[w.week] = w.active;
      return {
        key: c.cohortStart.toISOString(),
        label: monthLabel(c.cohortStart),
        color: "var(--series-1)",
        values,
        denominator: c.size,
      };
    });
  // Start on the newest cohort that has a line to draw, not a lone week-0 dot.
  const defaultCohort =
    [...retentionSeries].reverse().find((s) => s.values.filter((v) => v != null).length >= 2)
      ?.key ?? retentionSeries.at(-1)?.key;

  return (
    <>
      <AdminPageHeader
        title="Growth"
        subtitle={
          <>
            <span className="tabular-nums">{snapshot.total}</span> account
            {snapshot.total === 1 ? "" : "s"} ·{" "}
            <span className="tabular-nums">{snapshot.wau}</span> active in the last 7 days
          </>
        }
      />

      <GrowthTabs />

      <div className="space-y-6">
        <GrowthWindowNav
          base="/admin/growth/retention"
          range={range}
          grain={grain}
          spanDays={spanDays}
          first={first}
        />

        {/* Where things stand now, each against the period just before. Pairs of counts,
            never a growth rate. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <MetricTile
            label="Accounts"
            value={snapshot.total}
            hint={`+${snapshot.newNow} ${spanText}`}
          />
          <MetricTile
            label="New accounts"
            value={snapshot.newNow}
            hint={beforeText ?? spanText}
          />
          <MetricTile
            label="Active today"
            value={snapshot.dau}
            hint={`${snapshot.dauPrev} the day before`}
          />
          <MetricTile
            label="Active 7 days"
            value={snapshot.wau}
            hint={`${snapshot.wauPrev} the week before`}
          />
          <MetricTile
            label="Active 30 days"
            value={snapshot.mau}
            hint={`${snapshot.mauPrev} the 30 days before`}
          />
        </div>

        <AdminPanel title="Accounts over time">
          <TimeSeriesChart
            labels={labels}
            titles={titles}
            partialLast
            bucketHeading={BUCKET_HEADING[grain]}
            ariaLabel={`Accounts over time: ${snapshot.total} in total, ${snapshot.newNow} new ${spanText}.`}
            emptyLabel="No accounts yet."
            plots={[
              {
                title: "Total accounts",
                mark: "line",
                height: 150,
                series: [
                  {
                    key: "total",
                    label: "Total",
                    color: "var(--series-1)",
                    values: totals.map((p) => p.total),
                  },
                ],
              },
              {
                title: `New accounts per ${per}`,
                mark: "bar",
                height: 100,
                series: [
                  {
                    key: "added",
                    label: "New",
                    color: "var(--series-2)",
                    values: totals.map((p) => p.added),
                  },
                ],
              },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Counts accounts that still exist. Deleting an account purges its history, so
            the total can never show one that has since left.
          </p>
        </AdminPanel>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile label="Active this month" value={wan.mau} hint={`${wan.current} in the last 7 days`} />
          <MetricTile label="Came back" value={pools.resurrected} hint="active this week after four quiet weeks" />
          <MetricTile label="Going cold" value={pools.goingCold} hint="last active 3 to 8 weeks ago · a pool, not churn" />
          <MetricTile label="Dormant" value={pools.dormant} hint={`quiet 8+ weeks, of ${pools.everActive} who ever used it`} />
        </div>

        <AdminPanel title="Did something" action={<span className="text-xs text-muted-foreground">deliberate actions only</span>}>
          <TimeSeriesChart
            labels={labels}
            titles={titles}
            partialLast
            ariaLabel={`Active accounts: ${snapshot.dau} today, ${snapshot.wau} in 7 days, ${snapshot.mau} in 30 days.`}
            emptyLabel="Nobody has done anything in this window."
            notes={rolling.map((p) => [
              { label: "DAU of MAU", value: formatRate(p.dau, p.mau) },
            ])}
            plots={[
              {
                mark: "line",
                height: 266,
                series: [
                  {
                    key: "mau",
                    label: "30-day",
                    color: "var(--series-3)",
                    values: rolling.map((p) => p.mau),
                  },
                  {
                    key: "wau",
                    label: "7-day",
                    color: "var(--series-2)",
                    values: rolling.map((p) => p.wau),
                  },
                  {
                    key: "dau",
                    label: "1-day",
                    color: "var(--series-1)",
                    values: rolling.map((p) => p.dau),
                  },
                ],
              },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Accounts that wrote anything — a contact, note, chat, import or AI call — in
            the trailing 1, 7 and 30 days at the end of each {per}.
          </p>
        </AdminPanel>

        <AdminPanel
          title="Retention by signup month"
          action={
            <span className="text-xs text-muted-foreground">
              last {RETENTION_COHORTS} cohorts · pick one to compare
            </span>
          }
        >
          <TimeSeriesChart
            labels={Array.from({ length: RETENTION_WEEKS + 1 }, (_, w) => `W${w}`)}
            titles={Array.from({ length: RETENTION_WEEKS + 1 }, (_, w) =>
              w === 0 ? "Week 0 (signup week)" : `Week ${w} after signup`
            )}
            bucketHeading="Week"
            emphasis="select"
            defaultSelected={defaultCohort}
            ariaLabel="Accounts from each signup month still active in each week after joining."
            emptyLabel="No signups in the last six months."
            plots={[{ mark: "line", height: 220, series: retentionSeries }]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Each line is one month&apos;s signups: how many were still writing N weeks
            after joining. A week appears once every member has lived through it, so recent
            cohorts draw short lines rather than false drop-offs.
          </p>
        </AdminPanel>

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
              : `A churn rate is withheld below ${MIN_SUBSCRIBERS_FOR_CHURN_RATE} subscribers: one cancellation is a double-digit swing.`}{" "}
            Comped accounts are not subscribers.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
