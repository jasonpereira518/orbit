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
  TrendBars,
} from "@/components/admin/primitives";
import { TrafficTabs } from "@/components/admin/traffic-tabs";
import {
  RANGES,
  deviceBreakdown,
  geoBreakdown,
  rangeBuckets,
  rangeDays,
  rangeGrain,
  formatDuration,
  sourceBreakdown,
  topAccountsByTraffic,
  topRoutes,
  trafficTotals,
  trafficTrend,
  type Range,
} from "@/lib/admin-analytics";
import { analyticsDisabledReason } from "@/lib/analytics-visitor";

export const metadata = { title: "Admin · Traffic" };

/**
 * What happened before anybody signed up.
 *
 * Every other screen in this console starts from an account. `/admin/growth` opens with
 * signups, `/admin/billing` with revenue, and the funnel on `/admin` begins at "Signed
 * up" — so until this page there was no denominator anywhere for the question "of the
 * people who saw Orbit, how many stayed".
 *
 * TWO LABELS ON THIS PAGE ARE LOAD-BEARING, and both exist because the pipeline sets no
 * cookie:
 *
 *   "Visitor-days" is not a headcount. The visitor hash is salted per UTC day, so one
 *   person across a week is seven of them. The average-per-day hint beside it is the
 *   closest honest answer to "how many people", and neither number is ever called "users".
 *
 *   "Session length" is measured first pageview to last, plus whatever the exit beacon
 *   managed to report for the final page. A single-page visit with no beacon is therefore
 *   zero seconds, not unknown — which is why the bounce count sits next to it rather than
 *   being averaged in and quietly halving the figure.
 */
export default async function AdminTrafficPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const params = await searchParams;
  const range: Range = RANGES.includes(params.range as Range)
    ? (params.range as Range)
    : "30d";

  const disabled = analyticsDisabledReason();

  // Each panel degrades on its own rather than taking the page down — the pattern
  // `/admin/health` uses for the same reason.
  const [totals, trend, routes, geo, sources, devices, accounts] = await Promise.all([
    trafficTotals(range).catch(() => null),
    trafficTrend(rangeGrain(range), rangeBuckets(range)).catch(() => []),
    topRoutes(range).catch(() => []),
    geoBreakdown(range).catch(() => null),
    sourceBreakdown(range).catch(() => null),
    deviceBreakdown(range).catch(() => []),
    topAccountsByTraffic(range).catch(() => []),
  ]);

  const days = rangeDays(range);
  const grain = rangeGrain(range);
  /** MM-DD. For weekly buckets this is the week's first day, which is what the spine emits. */
  const label = (d: Date) => d.toISOString().slice(5, 10);

  const rangeLink = (value: Range) => (
    <a
      key={value}
      href={`/admin/analytics${value === "30d" ? "" : `?range=${value}`}`}
      className={
        range === value
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground"
      }
    >
      {value === "7d" ? "7 days" : value === "30d" ? "30 days" : "90 days"}
    </a>
  );

  // A real trickle over 90 days averages below one a day. "~0/day" beside a non-zero
  // total reads as a bug, so the sub-one case says so instead of rounding it away.
  const perDay = (n: number) => (n === 0 ? "0" : n < 1 ? "<1" : `~${Math.round(n)}`);

  return (
    <>
      <AdminPageHeader
        title="Traffic"
        subtitle={
          disabled ? (
            "Not recording."
          ) : (
            <>
              <span className="tabular-nums">
                {(totals?.views ?? 0).toLocaleString()}
              </span>{" "}
              page view{totals?.views === 1 ? "" : "s"} over {days} days ·{" "}
              <span className="tabular-nums">{totals?.sessions ?? 0}</span> session
              {totals?.sessions === 1 ? "" : "s"}
            </>
          )
        }
      />

      <TrafficTabs />

      {disabled ? (
        <AdminPanel title="Traffic collection is off">
          <p className="py-4 text-sm text-muted-foreground">
            {disabled} Set it to any long random string and redeploy; the value is the
            secret behind the daily visitor salt, so changing it later resets visitor
            identity from that day forward.
          </p>
          <p className="text-sm text-muted-foreground">
            It is deliberately optional — <code>check:env</code> gates every production
            deploy, and a missing analytics secret should never be able to stop one. The
            cost of that is this screen: an empty table and a disabled pipeline look
            identical, so this is the page saying which one it is.
          </p>
        </AdminPanel>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-3 text-xs">
            {rangeLink("7d")}
            <span className="text-muted-foreground/40">·</span>
            {rangeLink("30d")}
            <span className="text-muted-foreground/40">·</span>
            {rangeLink("90d")}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Page views"
              value={(totals?.views ?? 0).toLocaleString()}
              hint={
                totals?.botViews
                  ? `${totals.botViews.toLocaleString()} more filtered as automated`
                  : undefined
              }
            />
            <MetricTile
              label="Visitor-days"
              value={(totals?.visitorDays ?? 0).toLocaleString()}
              hint={`${perDay(totals?.avgDailyVisitors ?? 0)}/day · not a headcount`}
              tone="accent"
            />
            <MetricTile
              label="Median session"
              value={formatDuration(totals?.medianSessionSeconds ?? null)}
              hint="first pageview to last"
            />
            <MetricTile
              label="Bounced"
              value={`${totals?.bouncedSessions ?? 0} of ${totals?.sessions ?? 0}`}
              hint="one-page sessions"
              tone="muted"
            />
          </div>

          <AdminPanel title={grain === "week" ? "Views per week" : "Views per day"}>
            <TrendBars
              rows={trend.map((p) => ({
                label: label(p.bucketStart),
                count: p.views,
                secondary: p.visitorDays,
                secondaryLabel: "visitor-days",
              }))}
              emptyLabel="No traffic recorded in this window."
            />
          </AdminPanel>

          <AdminPanel title="Most viewed pages">
            {routes.length === 0 ? (
              <EmptyState>Nothing recorded yet.</EmptyState>
            ) : (
              <AdminTable
                head={
                  <>
                    <Th>Route</Th>
                    <Th numeric>Views</Th>
                    <Th numeric>Visitor-days</Th>
                    <Th numeric>Median time</Th>
                  </>
                }
              >
                {routes.map((r) => (
                  <tr key={r.route} className="border-b border-border/40">
                    <Td className="font-mono text-xs">{r.route}</Td>
                    <Td numeric>{r.views.toLocaleString()}</Td>
                    <Td numeric>{r.visitorDays.toLocaleString()}</Td>
                    <Td numeric className="text-muted-foreground">
                      {formatDuration(r.medianDwellSeconds)}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </AdminPanel>

          <div className="grid gap-6 lg:grid-cols-2">
            <AdminPanel title="Countries">
              {!geo || geo.countries.length === 0 ? (
                <EmptyState>
                  No geography recorded. Vercel&apos;s IP headers do not exist locally, so
                  this stays empty outside a deployment.
                </EmptyState>
              ) : (
                <MiniBars
                  rows={geo.countries.map((c) => ({
                    label: c.country ?? "Unknown",
                    count: c.views,
                  }))}
                />
              )}
            </AdminPanel>

            <AdminPanel title="Cities">
              {!geo || geo.cities.length === 0 ? (
                <EmptyState>No city-level data yet.</EmptyState>
              ) : (
                <MiniBars
                  rows={geo.cities.map((c) => ({
                    label: [c.city, c.country].filter(Boolean).join(", ") || "Unknown",
                    count: c.views,
                  }))}
                />
              )}
            </AdminPanel>

            <AdminPanel title="Referrers">
              {!sources || sources.referrers.length === 0 ? (
                <EmptyState>
                  No external referrers. Direct visits are not listed — they would be the
                  tallest bar and say nothing.
                </EmptyState>
              ) : (
                <MiniBars
                  rows={sources.referrers.map((s) => ({
                    label: s.label,
                    count: s.views,
                  }))}
                />
              )}
            </AdminPanel>

            <AdminPanel title="Campaigns">
              {!sources || sources.campaigns.length === 0 ? (
                <EmptyState>No tagged campaigns in this window.</EmptyState>
              ) : (
                <MiniBars
                  rows={sources.campaigns.map((s) => ({
                    label: s.label,
                    count: s.views,
                  }))}
                />
              )}
            </AdminPanel>
          </div>

          {/*
            Deliberately NOT the same question as Growth's "active accounts", which counts
            who WROTE something across five tables. Somebody who opens Orbit every morning
            and reads without editing is invisible there and shows up here.
          */}
          <AdminPanel title="Most active accounts">
            {accounts.length === 0 ? (
              <EmptyState>No signed-in traffic recorded in this window.</EmptyState>
            ) : (
              <AdminTable
                head={
                  <>
                    <Th>Account</Th>
                    <Th numeric>Views</Th>
                    <Th numeric>Sessions</Th>
                    <Th numeric>Days seen</Th>
                    <Th numeric>Measured time</Th>
                    <Th numeric>Last seen</Th>
                  </>
                }
              >
                {accounts.map((a) => (
                  <tr key={a.userId} className="border-b border-border/40">
                    <Td>
                      <Link
                        href={`/admin/users/${encodeURIComponent(a.userId)}`}
                        className="transition-colors duration-fast hover:text-primary"
                      >
                        {a.email ?? a.userId}
                      </Link>
                    </Td>
                    <Td numeric>{a.views.toLocaleString()}</Td>
                    <Td numeric>{a.sessions.toLocaleString()}</Td>
                    <Td numeric>{a.activeDays}</Td>
                    <Td numeric className="text-muted-foreground">
                      {formatDuration(a.totalDwellSeconds)}
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {a.lastSeen ? <RelativeTime date={a.lastSeen} /> : "—"}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </AdminPanel>

          <div className="grid gap-6 lg:grid-cols-2">
            <AdminPanel title="Devices">
              {devices.length === 0 ? (
                <EmptyState>Nothing recorded yet.</EmptyState>
              ) : (
                <MiniBars
                  rows={devices.map((d) => ({
                    label: d.device,
                    count: d.views,
                  }))}
                />
              )}
            </AdminPanel>

            <AdminPanel title="Signed in vs anonymous">
              <MiniBars
                rows={[
                  { label: "Signed in", count: totals?.signedInViews ?? 0 },
                  {
                    label: "Anonymous",
                    count: (totals?.views ?? 0) - (totals?.signedInViews ?? 0),
                  },
                ]}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                Admin console views are not recorded at all, so your own time in here does
                not appear on either bar.
              </p>
            </AdminPanel>
          </div>
        </div>
      )}
    </>
  );
}
