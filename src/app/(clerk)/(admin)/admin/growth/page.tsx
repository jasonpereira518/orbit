import Link from "next/link";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  MiniBars,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { TimeSeriesChart, type ChartSeries } from "@/components/admin/growth-charts";
import {
  activationTrend,
  depthTrend,
  featureAdoption,
  firstSignupAt,
  growthSnapshot,
  retentionCurves,
  rollingActiveTrend,
  userTotalsTrend,
  viewersTrend,
  type Grain,
} from "@/lib/admin-trends";
import { getWaitlist } from "@/lib/admin-product-health";
import { analyticsDisabledReason } from "@/lib/analytics-visitor";
import { formatRate } from "@/lib/format-rate";
import {
  GRAIN_LABEL,
  GROWTH_GRAINS,
  GROWTH_RANGES,
  RANGE_LABEL,
  grainAllowed,
  growthHref,
  rangeSpanDays,
  resolveGrowthWindow,
} from "@/lib/growth-range";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Growth" };

/** Retention looks at the last six monthly cohorts, twelve weeks out, whatever the range. */
const RETENTION_COHORTS = 6;
const RETENTION_WEEKS = 12;

const BUCKET_HEADING: Record<Grain, string> = { day: "Day", week: "Week", month: "Month" };

/**
 * How many people use Orbit, and how much, over time.
 *
 * Deliberately not on `/admin`, which stays triage-only. And deliberately narrow: this page
 * tracks accounts and what they do. Sections about the machinery (AI calls, data quality,
 * row counts) moved to Health, and "where onboarding stalls" moved to Conversion.
 *
 * Two kinds of engagement, in two charts, because they fail differently. "Opened Orbit"
 * (signed-in page views) sees the person who reads their network every morning and edits
 * nothing. "Did something" (writes) sees only people who act. Either alone misreports:
 * views flatter a product people glance at and leave; writes miss the readers.
 *
 * Counts, not rates, everywhere a number is printed — axes, tiles, tables. A percentage
 * appears only in a chart's readout, beside its fraction, and only past
 * `MIN_RATE_DENOMINATOR`. See `admin-trends.ts` for why the house rule bends that far and
 * no further.
 *
 * The window is `?range=` and `?grain=` in the URL, so a view can be linked and the page
 * stays a server component; the charts are client islands that only draw what they're given.
 */
export default async function AdminGrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; grain?: string }>;
}) {
  const params = await searchParams;
  const first = await firstSignupAt().catch(() => null);
  const { range, grain, buckets, spanDays } = resolveGrowthWindow(params, first);

  const [snapshot, totals, viewers, rolling, depth, curves, activation, adoption, waitlist] =
    await Promise.all([
      growthSnapshot(spanDays),
      userTotalsTrend(grain, buckets),
      // Degrades on its own: a missing page_views table empties one chart, not the page.
      viewersTrend(grain, buckets).catch(() => null),
      rollingActiveTrend(grain, buckets),
      depthTrend(grain, buckets),
      retentionCurves(RETENTION_COHORTS, RETENTION_WEEKS),
      activationTrend(grain, buckets),
      featureAdoption(),
      getWaitlist().catch(() => null),
    ]);

  const labels = totals.map((p) => shortLabel(p.bucketStart, grain));
  const titles = totals.map((p) => longLabel(p.bucketStart, grain));
  const per = grain === "day" ? "day" : grain;
  const trackingOff = analyticsDisabledReason();

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

  const ratio = (count: number, active: number) =>
    active > 0 ? Math.round((count / active) * 10) / 10 : 0;

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

      <div className="space-y-6">
        {/* One row of filters, above everything it scopes. Links, not client state: the
            window belongs in the URL. */}
        <nav
          aria-label="Time window"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs"
        >
          <div className="flex items-center gap-3">
            {GROWTH_RANGES.map((r, i) => (
              <span key={r} className="flex items-center gap-3">
                {i > 0 && <span className="text-muted-foreground/40">·</span>}
                <Link
                  href={growthHref(r, grainAllowed(grain, rangeSpanDays(r, first)) ? grain : null)}
                  aria-current={range === r ? "page" : undefined}
                  className={
                    range === r ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }
                >
                  {RANGE_LABEL[r]}
                </Link>
              </span>
            ))}
          </div>
          <span aria-hidden className="h-3 w-px bg-border" />
          <div className="flex items-center gap-3">
            {GROWTH_GRAINS.map((g, i) => {
              const allowed = grainAllowed(g, spanDays);
              return (
                <span key={g} className="flex items-center gap-3">
                  {i > 0 && <span className="text-muted-foreground/40">·</span>}
                  {allowed ? (
                    <Link
                      href={growthHref(range, g)}
                      aria-current={grain === g ? "page" : undefined}
                      className={
                        grain === g
                          ? "text-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }
                    >
                      {GRAIN_LABEL[g]}
                    </Link>
                  ) : (
                    <span
                      className="cursor-not-allowed text-muted-foreground/40"
                      title={
                        g === "day"
                          ? "Daily stops at 90 days — past that it's a smear, not a chart."
                          : "One monthly bar for 30 days would be a single number."
                      }
                    >
                      {GRAIN_LABEL[g]}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </nav>

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

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Opened Orbit">
            {!viewers ? (
              <EmptyState>Signed-in page views are unavailable.</EmptyState>
            ) : (
              <TimeSeriesChart
                labels={labels}
                titles={titles}
                partialLast
                ariaLabel={`Accounts that opened Orbit per ${per}.`}
                emptyLabel={trackingOff ?? "No signed-in page views in this window."}
                plots={[
                  {
                    title: `Accounts with a signed-in view, per ${per}`,
                    mark: "line",
                    height: 150,
                    series: [
                      {
                        key: "viewers",
                        label: "Accounts",
                        color: "var(--series-1)",
                        values: viewers.map((p) => p.viewers),
                      },
                    ],
                  },
                  {
                    title: `Page views per ${per}`,
                    mark: "bar",
                    height: 90,
                    series: [
                      {
                        key: "views",
                        label: "Views",
                        color: "var(--series-3)",
                        values: viewers.map((p) => p.views),
                      },
                    ],
                  },
                ]}
              />
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Signed-in views only, bots excluded. This is who showed up — including people
              who read and changed nothing.
            </p>
          </AdminPanel>

          <AdminPanel title="Did something">
            <TimeSeriesChart
              labels={labels}
              titles={titles}
              partialLast
              ariaLabel={`Active accounts: ${snapshot.dau} today, ${snapshot.wau} in 7 days, ${snapshot.mau} in 30 days.`}
              emptyLabel="Nobody has written anything in this window."
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
        </div>

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

        <AdminPanel title="Actions per active account">
          <TimeSeriesChart
            labels={labels}
            titles={titles}
            partialLast
            ariaLabel={`Actions per active account per ${per}, by feature.`}
            emptyLabel="Nobody has done anything in this window."
            notes={depth.map((p) => [
              { label: "Active accounts", value: p.active.toLocaleString() },
              {
                label: "Actions",
                value: (p.captures + p.notes + p.chats + p.imports).toLocaleString(),
              },
            ])}
            plots={[
              {
                mark: "stacked",
                height: 200,
                decimals: 1,
                series: [
                  {
                    key: "captures",
                    label: "Captures",
                    color: "var(--series-1)",
                    values: depth.map((p) => ratio(p.captures, p.active)),
                  },
                  {
                    key: "notes",
                    label: "Notes logged",
                    color: "var(--series-2)",
                    values: depth.map((p) => ratio(p.notes, p.active)),
                  },
                  {
                    key: "chats",
                    label: "Chat messages",
                    color: "var(--series-3)",
                    values: depth.map((p) => ratio(p.chats, p.active)),
                  },
                  {
                    key: "imports",
                    label: "Imports",
                    color: "var(--series-4)",
                    values: depth.map((p) => ratio(p.imports, p.active)),
                  },
                ],
              },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Deliberate actions only, each counted once: a capture&apos;s notes are not
            counted again as notes, synced and imported interactions are excluded, and AI
            calls (a side effect of these) are on the Health page.
          </p>
        </AdminPanel>

        <AdminPanel title="Activation by signup cohort">
          {activation.every((p) => p.signed === 0) ? (
            <EmptyState>No signups in this window.</EmptyState>
          ) : (
            <AdminTable
              minWidth="sm"
              head={
                <>
                  <Th>Joined</Th>
                  <Th numeric>Signed up</Th>
                  <Th numeric>Onboarded</Th>
                  <Th numeric>Added a contact</Th>
                </>
              }
            >
              {/* Newest first, and only periods anyone joined in — at daily grain the
                  empty days would bury the ones that matter. */}
              {[...activation]
                .reverse()
                .filter((p) => p.signed > 0)
                .map((p) => (
                  <tr
                    key={p.bucketStart.toISOString()}
                    className="border-b border-border/40 last:border-b-0"
                  >
                    <Td className="tabular-nums">{longLabel(p.bucketStart, grain)}</Td>
                    <Td numeric>{p.signed}</Td>
                    <Td
                      numeric
                      className={cn(p.onboarded === 0 && "text-destructive")}
                    >
                      {formatRate(p.onboarded, p.signed)}
                    </Td>
                    <Td numeric>{formatRate(p.firstContact, p.signed)}</Td>
                  </tr>
                ))}
            </AdminTable>
          )}
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* The one cross-account total that changes a decision: which parts of Orbit are
              load-bearing and which are decoration. */}
          <AdminPanel title="Accounts that have used each feature">
            <MiniBars
              rows={[
                { label: "Imports", count: adoption.imports },
                { label: "Chat", count: adoption.chat },
                { label: "Goals", count: adoption.goals },
                { label: "Calendar", count: adoption.calendar },
                { label: "Recruiters", count: adoption.recruiters },
                { label: "Gmail", count: adoption.gmail },
                { label: "Outreach", count: adoption.outreach },
                { label: "Outlook", count: adoption.outlook },
              ].sort((a, b) => b.count - a.count)}
            />
          </AdminPanel>

          <AdminPanel
            title="Interest list"
            action={
              <Link
                href="/admin/growth/interest-list"
                className="text-xs text-muted-foreground underline underline-offset-2 transition-colors duration-fast hover:text-primary"
              >
                View all
              </Link>
            }
          >
            {!waitlist ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : waitlist.total === 0 ? (
              <EmptyState>No signups yet.</EmptyState>
            ) : (
              <>
                <MetricTile label="Signups" value={waitlist.total} />
                <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-sm">
                  {waitlist.recent.map((w, i) => (
                    <li key={i} className="flex justify-between gap-4">
                      <span className="truncate">{w.email ?? "—"}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <RelativeTime date={w.at} /> ago
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AdminPanel>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- labels --------- */

// Buckets come back as UTC midnights from date_trunc, so every label is formatted in UTC —
// in local time a Monday bucket would read as Sunday for anyone west of Greenwich.

function shortLabel(d: Date, grain: Grain) {
  if (grain === "month") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function longLabel(d: Date, grain: Grain) {
  if (grain === "month") return monthLabel(d);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (grain === "week") return `Week of ${date}`;
  const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday}, ${date}`;
}

function monthLabel(d: Date) {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
