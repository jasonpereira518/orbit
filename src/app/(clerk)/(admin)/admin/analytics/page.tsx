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
import { InternalBrowserToggle } from "@/components/admin/internal-browser-toggle";
import {
  ENGAGED_SECONDS,
  RANGES,
  deviceBreakdown,
  geoBreakdown,
  rangeDays,
  rangeGrain,
  formatDuration,
  sourceBreakdown,
  topAccountsByTraffic,
  routeLoadTimes,
  topRoutes,
  trafficTotals,
  trafficTrend,
  type Range,
} from "@/lib/admin-analytics";
import { analyticsDisabledReason } from "@/lib/analytics-visitor";

export const metadata = { title: "Admin · Traffic" };

/** 840 → "840 ms", 2310 → "2.3 s". */
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

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
 *   "Median session" is measured first view to last, plus whatever the exit beacon
 *   managed to report for the final page. A single-page visit whose beacon never landed has
 *   no measurable length and is left out, rather than counted as zero seconds and dragging
 *   the median towards nothing.
 *
 * Bounces are MARKETING bounces: anonymous sessions that saw one page and left inside
 * `ENGAGED_SECONDS`. A signed-in customer opening their dashboard and closing the tab has
 * not bounced, and one page read for five minutes is not a bounce either.
 *
 * Orbit's own traffic — admins, the showcase account, opted-out browsers — is excluded from
 * everything here and counted beside the page-views tile, the same way bots are.
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
  const [totals, trend, routes, geo, sources, devices, accounts, loads] = await Promise.all([
    trafficTotals(range).catch(() => null),
    trafficTrend(range).catch(() => []),
    topRoutes(range).catch(() => []),
    geoBreakdown(range).catch(() => null),
    sourceBreakdown(range).catch(() => null),
    deviceBreakdown(range).catch(() => []),
    topAccountsByTraffic(range).catch(() => []),
    routeLoadTimes(range).catch(() => []),
  ]);

  const grain = rangeGrain(range);
  const window = totals?.window;
  // Over the days that HAVE data: a 90-day range twelve days after tracking began is twelve.
  const shownDays = window ? Math.max(1, Math.round(window.days)) : rangeDays(range);
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
  const excluded = [
    totals?.botViews ? `${totals.botViews.toLocaleString()} automated` : null,
    totals?.internalViews ? `${totals.internalViews.toLocaleString()} of Orbit's own` : null,
  ].filter(Boolean);
  const excludedHint = excluded.length ? `${excluded.join(" · ")} not counted` : undefined;

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
              page view{totals?.views === 1 ? "" : "s"} over {shownDays} day
              {shownDays === 1 ? "" : "s"}
              {window?.clamped && (
                <> (tracking began {window.from.toISOString().slice(0, 10)})</>
              )}{" "}
              · <span className="tabular-nums">{totals?.sessions ?? 0}</span> session
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-xs">
              {rangeLink("7d")}
              <span className="text-muted-foreground/40">·</span>
              {rangeLink("30d")}
              <span className="text-muted-foreground/40">·</span>
              {rangeLink("90d")}
            </div>
            <InternalBrowserToggle />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Page views"
              value={(totals?.views ?? 0).toLocaleString()}
              hint={excludedHint}
            />
            <MetricTile
              label="Visitor-days"
              value={(totals?.visitorDays ?? 0).toLocaleString()}
              hint={`${perDay(totals?.avgDailyVisitors ?? 0)}/day over ${shownDays} measured day${shownDays === 1 ? "" : "s"} · not a headcount`}
              tone="accent"
            />
            <MetricTile
              label="Median session"
              value={formatDuration(totals?.medianSessionSeconds ?? null)}
              hint={`first view to last, plus time on the last page · ${(totals?.measuredSessions ?? 0).toLocaleString()} measured`}
            />
            <MetricTile
              label="Marketing bounce"
              value={`${totals?.bouncedSessions ?? 0} of ${totals?.anonymousSessions ?? 0}`}
              hint={`signed-out visits that saw one page for under ${ENGAGED_SECONDS}s`}
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
                partial: p.partial,
              }))}
              secondaryTone="neutral"
              headings={{ count: "Views", secondary: "Visitors" }}
              emptyLabel="No traffic recorded in this window."
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {grain === "week" ? "Weeks" : "Days"} are cut in UTC, the same boundary the
              visitor hash rotates on, so they will not line up with a local-time dashboard.
              Periods before tracking began are not drawn.
            </p>
          </AdminPanel>

          <AdminPanel title="Most viewed pages">
            {routes.length === 0 ? (
              <EmptyState>Nothing recorded yet.</EmptyState>
            ) : (
              <AdminTable minWidth="sm"
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
                      {r.dwellSamples > 0 && (
                        <span className="ml-1 text-muted-foreground/60">
                          (n={r.dwellSamples.toLocaleString()})
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </AdminPanel>

          <AdminPanel title="Page load speed">
            {loads.length === 0 ? (
              <EmptyState>
                No page loads measured in this window. A view is timed from navigation start
                until no loading skeleton is left on screen.
              </EmptyState>
            ) : (
              <AdminTable minWidth="sm"
                head={
                  <>
                    <Th>Route</Th>
                    <Th>Kind</Th>
                    <Th numeric>Samples</Th>
                    <Th numeric>p50</Th>
                    <Th numeric>p75</Th>
                    <Th numeric>p95</Th>
                  </>
                }
              >
                {loads.map((r) => (
                  <tr key={`${r.route}:${r.navType}`} className="border-b border-border/40">
                    <Td className="font-mono text-xs">{r.route}</Td>
                    {/* Full loads include TTFB and cold starts; in-app clicks start at the
                        router. Different populations, so they get separate rows. */}
                    <Td className="text-muted-foreground">
                      {r.navType === "hard" ? "Full load" : "In-app click"}
                    </Td>
                    <Td numeric>{r.samples.toLocaleString()}</Td>
                    <Td numeric>{formatMs(r.p50Ms)}</Td>
                    <Td numeric>{formatMs(r.p75Ms)}</Td>
                    <Td numeric className="text-muted-foreground">
                      {formatMs(r.p95Ms)}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </AdminPanel>

          <div className="grid gap-6 lg:grid-cols-2">
            <AdminPanel title="Countries">
              {!geo || geo.countries.every((c) => c.country == null) ? (
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
                    // Region included: two Springfields in one country were identical rows.
                    label: [c.city, c.region, c.country].filter(Boolean).join(", ") || "Unknown",
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

            <AdminPanel title="Sources (utm_source)">
              {!sources || sources.sources.length === 0 ? (
                <EmptyState>No tagged sources in this window.</EmptyState>
              ) : (
                <MiniBars
                  rows={sources.sources.map((s) => ({
                    label: s.label,
                    count: s.views,
                  }))}
                />
              )}
            </AdminPanel>

            <AdminPanel title="Campaigns (utm_campaign)">
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
                    {/* The share of views whose exit beacon landed: a total from a thin
                        sample is not "how long they spent in Orbit". */}
                    <Th numeric>Measured time (of views)</Th>
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
                      <span className="ml-1 text-muted-foreground/60">
                        ({Math.round(a.dwellCoverage * 100)}%)
                      </span>
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
                Neither bar includes Orbit&apos;s own traffic: admin console views are never
                recorded, and your account, the showcase account and any browser marked
                &ldquo;don&apos;t count&rdquo; are left out of everything on this page.
              </p>
            </AdminPanel>
          </div>
        </div>
      )}
    </>
  );
}
