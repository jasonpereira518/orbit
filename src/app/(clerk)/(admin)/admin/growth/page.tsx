import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  MiniBars,
  Td,
  Th,
  TrendBars,
} from "@/components/admin/primitives";
import { GrowthTabs } from "@/components/admin/admin-tabs";
import { InternalBrowserToggle } from "@/components/admin/internal-browser-toggle";
import {
  ENGAGED_SECONDS,
  MIN_RATE_DENOMINATOR,
  RANGES,
  acquisitionFunnel,
  deviceBreakdown,
  formatDuration,
  geoBreakdown,
  rangeDays,
  rangeGrain,
  sourceBreakdown,
  topRoutes,
  trafficTotals,
  trafficTrend,
  type Range,
} from "@/lib/admin-analytics";
import { analyticsDisabledReason } from "@/lib/analytics-visitor";
import { formatRate } from "@/lib/format-rate";
import { channelBreakdown, freeToPaid } from "@/lib/product-metrics";
import { TrafficRangeLinks } from "./range-nav";

export const metadata = { title: "Admin · Growth · Acquisition" };

/**
 * Acquisition: what happened before anybody signed up, and what it turned into.
 *
 * Every other screen in this console starts from an account. This one supplies the
 * denominator for "of the people who saw Orbit, how many stayed": traffic, the conversion
 * funnel, and where sign-ups came from.
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
 * THE FUNNEL BREAKS THE HOUSE RULE, ON PURPOSE AND WITH A LIMIT. Conversion rate is a ratio
 * or it is nothing, so every stage prints its own fraction and the percentage is withheld
 * until the denominator reaches {@link MIN_RATE_DENOMINATOR}. Its stages are NOT one chain
 * of people: 1-2 count traffic, 3 the interest list, 4-6 accounts — three populations over
 * the same days. Nothing connects the visitor who read /pricing on Tuesday to the account
 * created on Thursday, because the visitor hash dies at midnight.
 *
 * Orbit's own traffic — admins, the showcase account, opted-out browsers — is excluded from
 * everything here and counted beside the page-views tile, the same way bots are.
 */
export default async function AdminAcquisitionPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const params = await searchParams;
  const range: Range = RANGES.includes(params.range as Range)
    ? (params.range as Range)
    : "30d";

  const disabled = analyticsDisabledReason();
  const now = new Date();

  // Each panel degrades on its own rather than taking the page down.
  const [totals, trend, routes, geo, sources, devices, stages, channels, paid] =
    await Promise.all([
      trafficTotals(range).catch(() => null),
      trafficTrend(range).catch(() => []),
      topRoutes(range).catch(() => []),
      geoBreakdown(range).catch(() => null),
      sourceBreakdown(range).catch(() => null),
      deviceBreakdown(range).catch(() => []),
      acquisitionFunnel(range).catch(() => []),
      channelBreakdown(now, rangeDays(range)).catch(() => []),
      freeToPaid(now).catch(() => null),
    ]);

  const grain = rangeGrain(range);
  const window = totals?.window;
  // Over the days that HAVE data: a 90-day range twelve days after tracking began is twelve.
  const shownDays = window ? Math.max(1, Math.round(window.days)) : rangeDays(range);
  /** MM-DD. For weekly buckets this is the week's first day, which is what the spine emits. */
  const label = (d: Date) => d.toISOString().slice(5, 10);

  // A real trickle over 90 days averages below one a day. "~0/day" beside a non-zero
  // total reads as a bug, so the sub-one case says so instead of rounding it away.
  const excluded = [
    totals?.botViews ? `${totals.botViews.toLocaleString()} automated` : null,
    totals?.internalViews ? `${totals.internalViews.toLocaleString()} of Orbit's own` : null,
  ].filter(Boolean);
  const excludedHint = excluded.length ? `${excluded.join(" · ")} not counted` : undefined;

  const perDay = (n: number) => (n === 0 ? "0" : n < 1 ? "<1" : `~${Math.round(n)}`);

  // Each funnel population is scaled against its own largest stage. One scale across all
  // three drew a few signups as a sliver under thousands of visitor-days.
  const groupMax = new Map<string, number>();
  for (const stage of stages) {
    groupMax.set(stage.group, Math.max(groupMax.get(stage.group) ?? 1, stage.count));
  }

  return (
    <>
      <AdminPageHeader
        title="Growth"
        subtitle={
          disabled ? (
            "Traffic is not recording."
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

      <GrowthTabs />

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
            <TrafficRangeLinks base="/admin/growth" range={range} />
            <InternalBrowserToggle />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
            <MetricTile
              label="Free to paid"
              value={paid ? formatRate(paid.paid, paid.eligible) : "—"}
              hint={
                paid && paid.paid >= 5 && paid.medianDaysToPay !== null
                  ? `activated accounts a month old · median ${paid.medianDaysToPay} days to pay`
                  : "activated accounts a month old · median shown from five payers"
              }
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

          <AdminPanel title="Conversion funnel">
            {stages.length === 0 ? (
              <EmptyState>Nothing recorded in this window yet.</EmptyState>
            ) : (
              <AdminTable label="Conversion funnel" minWidth="none"
                head={
                  <>
                    <Th>Stage</Th>
                    <Th numeric>Count</Th>
                    <Th>Conversion</Th>
                  </>
                }
              >
                {stages.map((stage) => (
                  <tr key={stage.label} className="border-b border-border/40">
                    <Td>
                      <div>{stage.label}</div>
                      {stage.note && (
                        <div className="text-xs text-muted-foreground">{stage.note}</div>
                      )}
                    </Td>
                    <Td numeric>{stage.count.toLocaleString()}</Td>
                    <Td>
                      <div className="flex items-center gap-3">
                        {/* Hand-built, like every other bar in this console. */}
                        <div
                          className="h-1.5 shrink-0 rounded-full bg-primary/70"
                          style={{
                            width: `${(stage.count / (groupMax.get(stage.group) ?? 1)) * 100}%`,
                            minWidth: 2,
                          }}
                          aria-hidden
                        />
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {stage.of == null
                            ? "—"
                            : `${formatRate(stage.count, stage.of)} ${stage.ofLabel ?? ""}`.trim()}
                        </span>
                      </div>
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
            <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
              Three populations over the same days — traffic, the interest list, accounts —
              not one group of people followed through; percentages appear from{" "}
              {MIN_RATE_DENOMINATOR}, and Activated and Paid (Lifetime included, net of
              refunds) count only accounts a week old.
            </p>
          </AdminPanel>

          <AdminPanel title="Most viewed pages">
            {routes.length === 0 ? (
              <EmptyState>Nothing recorded yet.</EmptyState>
            ) : (
              <AdminTable label="Most viewed pages" minWidth="sm"
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

          {/* Visits and sign-ups side by side: page views say who arrived from where, the
              sign-up table says which of those first touches became accounts. Two
              pipelines with no join between them, so two lists, one panel. */}
          <AdminPanel title="Sources">
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <SubHeading>Sign-ups by first touch</SubHeading>
                {channels.length === 0 ? (
                  <EmptyState>No sign-ups in this window.</EmptyState>
                ) : (
                  <AdminTable
                    label="Sign-ups by first touch"
                    minWidth="none"
                    head={
                      <>
                        <Th>First touch</Th>
                        <Th numeric>Sign-ups</Th>
                        <Th numeric>Activated</Th>
                      </>
                    }
                  >
                    {channels.map((c) => (
                      <tr key={c.channel} className="border-b border-border/40 last:border-b-0">
                        <Td>{c.channel}</Td>
                        <Td numeric>{c.signups}</Td>
                        <Td numeric>{c.matured === 0 ? "—" : formatRate(c.activated, c.matured)}</Td>
                      </tr>
                    ))}
                  </AdminTable>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  Invited accounts carry the waitlist row&apos;s first touch.
                  &ldquo;unattributed&rdquo; never rendered the app (API or connector only);
                  it is not &ldquo;direct&rdquo;.
                </p>
              </div>
              <div className="space-y-4">
                <div>
                  <SubHeading>Referrers · views</SubHeading>
                  {!sources || sources.referrers.length === 0 ? (
                    <EmptyState>
                      No external referrers. Direct visits are not listed — they would be
                      the tallest bar and say nothing.
                    </EmptyState>
                  ) : (
                    <MiniBars rows={sources.referrers.map((s) => ({ label: s.label, count: s.views }))} />
                  )}
                </div>
                {sources && sources.sources.length > 0 && (
                  <div>
                    <SubHeading>utm_source · views</SubHeading>
                    <MiniBars rows={sources.sources.map((s) => ({ label: s.label, count: s.views }))} />
                  </div>
                )}
                {sources && sources.campaigns.length > 0 && (
                  <div>
                    <SubHeading>utm_campaign · views</SubHeading>
                    <MiniBars rows={sources.campaigns.map((s) => ({ label: s.label, count: s.views }))} />
                  </div>
                )}
              </div>
            </div>
          </AdminPanel>

          <div className="grid gap-6 lg:grid-cols-2">
            <AdminPanel title="Geography">
              {!geo || geo.countries.every((c) => c.country == null) ? (
                <EmptyState>
                  No geography recorded. Vercel&apos;s IP headers do not exist locally, so
                  this stays empty outside a deployment.
                </EmptyState>
              ) : (
                <>
                  <SubHeading>Countries · views</SubHeading>
                  <MiniBars
                    rows={geo.countries.map((c) => ({
                      label: c.country ?? "Unknown",
                      count: c.views,
                    }))}
                  />
                  <div className="mt-4">
                    <SubHeading>Cities · views</SubHeading>
                    {geo.cities.length === 0 ? (
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
                  </div>
                </>
              )}
            </AdminPanel>

            <AdminPanel title="Audience">
              <SubHeading>Devices</SubHeading>
              {devices.length === 0 ? (
                <EmptyState>Nothing recorded yet.</EmptyState>
              ) : (
                <MiniBars rows={devices.map((d) => ({ label: d.device, count: d.views }))} />
              )}
              <div className="mt-4">
                <SubHeading>Signed in vs anonymous</SubHeading>
                <MiniBars
                  rows={[
                    { label: "Signed in", count: totals?.signedInViews ?? 0 },
                    {
                      label: "Anonymous",
                      count: (totals?.views ?? 0) - (totals?.signedInViews ?? 0),
                    },
                  ]}
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Neither includes Orbit&apos;s own traffic: admin console views are never
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

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
