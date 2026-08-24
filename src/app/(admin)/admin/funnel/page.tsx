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
import {
  activationTrend,
  activeTrend,
  aiVolumeTrend,
  retentionCohorts,
  signupTrend,
  type Grain,
} from "@/lib/admin-trends";
import {
  CHANNEL_RATE_MINIMUM,
  STICKINESS_MINIMUM_MAU,
  channelBreakdown,
  engagementDepth,
  topOfFunnel,
} from "@/lib/admin-funnel";
import {
  getDataQuality,
  getFunnelParking,
  getWaitlist,
} from "@/lib/admin-product-health";

export const metadata = { title: "Admin · Funnel" };

/**
 * Trends, deliberately not on `/admin`.
 *
 * The overview's rule — absolute integers, no percentages, no sparklines — stays intact
 * there and, in the parts that matter, here too: every number on this page is a count of
 * accounts, never a rate. Retention reads "14 signed up, 9 came back", not "64%", because
 * at this scale a percentage is two people wearing a confidence interval.
 *
 * What bends is only the ban on sparklines, and only because `TrendBars` prints the integer
 * for every bucket. The objection was to smoothed shapes with no labels; a labelled column
 * of numbers is the same information the roster would give you, sorted by time.
 */
export default async function AdminGrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ grain?: string }>;
}) {
  const params = await searchParams;
  const grain: Grain = params.grain === "month" ? "month" : "week";
  const buckets = grain === "month" ? 12 : 12;

  // Feature adoption, AI-operation adoption and durable artifacts moved to /admin/product:
  // they answer "what should I build", where this screen answers "do people arrive and
  // stay". They were only ever together because both were new at the same time.
  const [
    signups,
    actives,
    activation,
    cohorts,
    aiVolume,
    parking,
    waitlist,
    quality,
    channels,
    engagement,
    funnel,
  ] = await Promise.all([
    signupTrend(grain, buckets),
    activeTrend(grain, buckets),
    activationTrend(grain, buckets),
    retentionCohorts(6),
    aiVolumeTrend(grain, buckets),
    getFunnelParking(),
    // Waitlist rides on the webhook ledger, so it degrades on its own if that is absent.
    getWaitlist().catch(() => null),
    getDataQuality(),
    // The three that only became answerable once attribution and the presence heartbeat
    // shipped. Each degrades to an empty shape rather than taking the screen down.
    channelBreakdown().catch(() => []),
    engagementDepth().catch(() => ({
      dau: 0,
      wau: 0,
      mau: 0,
      stickiness: null,
      liveNow: 0,
      minimumForStickiness: STICKINESS_MINIMUM_MAU,
    })),
    topOfFunnel().catch(() => ({
      waitlistEntries: null,
      signups: 0,
      activated: 0,
      everWrote: 0,
    })),
  ]);

  const label = (d: Date) =>
    grain === "month"
      ? d.toISOString().slice(0, 7)
      : d.toISOString().slice(5, 10);

  const totalSignups = signups.reduce((a, p) => a + p.count, 0);

  const grainLink = (value: Grain) => (
    <a
      href={`/admin/funnel${value === "week" ? "" : "?grain=month"}`}
      className={
        grain === value
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground"
      }
    >
      {value === "week" ? "Weekly" : "Monthly"}
    </a>
  );

  return (
    <>
      <AdminPageHeader
        title="Funnel"
        subtitle={
          <>
            <span className="tabular-nums">{totalSignups}</span> signup
            {totalSignups === 1 ? "" : "s"} in the last {buckets} {grain}s ·{" "}
            <span className="tabular-nums">{engagement.liveNow}</span> active right now
          </>
        }
      />

      <div className="space-y-6">
        <div className="flex items-center gap-3 text-xs">
          {grainLink("week")}
          <span className="text-muted-foreground/40">·</span>
          {grainLink("month")}
        </div>

        {/* ---------------------------------------------------- top of funnel ---- */}

        <AdminPanel title="Where accounts came from">
          {channels.length === 0 ? (
            <EmptyState>No accounts yet.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Channel</Th>
                  <Th numeric>Accounts</Th>
                  <Th numeric>Activated</Th>
                  <Th numeric>Rate</Th>
                  <Th numeric>First seen</Th>
                </>
              }
            >
              {channels.map((c) => (
                <tr key={c.channel} className="border-b border-border/40 last:border-b-0">
                  <Td
                    className={
                      c.channel === "unattributed"
                        ? "font-mono text-xs text-muted-foreground"
                        : "font-mono text-xs"
                    }
                  >
                    {c.channel}
                  </Td>
                  <Td numeric>{c.accounts}</Td>
                  <Td numeric>{c.activated}</Td>
                  <Td numeric className="text-muted-foreground">
                    {c.activationRate === null ? "—" : `${c.activationRate}%`}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={c.firstAt} />
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
            Discovery, not acquisition cost — there is no ad spend to divide by, so a CAC
            figure here would be a division by zero wearing a metric&apos;s clothes. The
            useful reading is &ldquo;half of these came from one thread&rdquo;. Rates are
            withheld below {CHANNEL_RATE_MINIMUM} accounts, where they swing tens of points
            per person. <code className="font-mono">unattributed</code> is accounts that
            predate the attribution mirror, kept in the denominator rather than hidden.
          </p>
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Reach">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Waitlist entries"
                value={
                  funnel.waitlistEntries === null
                    ? "—"
                    : String(funnel.waitlistEntries)
                }
                hint="from the webhook ledger"
              />
              <MetricTile label="Signups" value={String(funnel.signups)} />
              <MetricTile
                label="Activated"
                value={String(funnel.activated)}
                hint="finished onboarding"
              />
              <MetricTile
                label="Ever added a contact"
                value={String(funnel.everWrote)}
                hint="the first real use"
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Four independent counts, not a funnel with drop-off between them: somebody can
              sign up without ever joining the waitlist, so waitlist entries are not a
              superset of signups and subtracting them would produce a negative stage.
            </p>
          </AdminPanel>

          <AdminPanel title="How deeply it is used">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Active today"
                value={String(engagement.dau)}
              />
              <MetricTile label="This week" value={String(engagement.wau)} />
              <MetricTile label="This month" value={String(engagement.mau)} />
              <MetricTile
                label="Stickiness"
                value={
                  engagement.stickiness === null
                    ? "—"
                    : `${engagement.stickiness}%`
                }
                hint={
                  engagement.stickiness === null
                    ? `needs ${engagement.minimumForStickiness} monthly actives`
                    : "days used per month"
                }
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Measurable for the first time. Before the presence heartbeat,{" "}
              <code className="font-mono">last_active_at</code> moved at most once every
              fifteen minutes and only on a server request — so anyone reading and scrolling
              counted as idle, and these were exactly the users it missed.
            </p>
          </AdminPanel>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title={`Signups by ${grain}`}>
            <TrendBars
              rows={signups.map((p) => ({
                label: label(p.bucketStart),
                count: p.count,
              }))}
              emptyLabel="No signups in this window."
            />
          </AdminPanel>

          {/* Distinct accounts that WROTE something, not last_active_at: that column is a
              throttled stamp of the latest session and carries no history. */}
          <AdminPanel title={`Accounts writing, by ${grain}`}>
            <TrendBars
              rows={actives.map((p) => ({
                label: label(p.bucketStart),
                count: p.count,
              }))}
              emptyLabel="Nobody has written anything in this window."
            />
          </AdminPanel>
        </div>

        <AdminPanel title="Activation by signup cohort">
          {activation.every((p) => p.signed === 0) ? (
            <EmptyState>No signups in this window.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Joined</Th>
                  <Th numeric>Signed up</Th>
                  <Th numeric>Onboarded</Th>
                  <Th numeric>Added a contact</Th>
                </>
              }
            >
              {activation.map((p) => (
                <tr
                  key={p.bucketStart.toISOString()}
                  className="border-b border-border/40 last:border-b-0"
                >
                  <Td className="tabular-nums">{label(p.bucketStart)}</Td>
                  <Td numeric>{p.signed}</Td>
                  <Td numeric className={p.onboarded === 0 && p.signed > 0 ? "text-destructive" : undefined}>
                    {p.onboarded}
                  </Td>
                  <Td numeric>{p.firstContact}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        {/* Three integers per cohort, never a percentage grid: at this scale a retention
            percentage has one or two people behind it. */}
        <AdminPanel title="Did each month's intake stick?">
          <AdminTable
            head={
              <>
                <Th>Cohort</Th>
                <Th numeric>Signed up</Th>
                <Th numeric>Still writing after 30 days</Th>
                <Th numeric>Active in the last 30 days</Th>
              </>
            }
          >
            {cohorts.map((c) => (
              <tr
                key={c.cohortStart.toISOString()}
                className="border-b border-border/40 last:border-b-0"
              >
                <Td className="tabular-nums">
                  {c.cohortStart.toISOString().slice(0, 7)}
                </Td>
                <Td numeric>{c.size}</Td>
                <Td numeric>{c.returnedAfter30d}</Td>
                <Td numeric>{c.activeNow}</Td>
              </tr>
            ))}
          </AdminTable>
        </AdminPanel>

        <AdminPanel
            title={`AI calls by ${grain}`}
            action={
              <span className="text-xs text-muted-foreground">
                failures in red
              </span>
            }
          >
            <TrendBars
              rows={aiVolume.map((p) => ({
                label: label(p.bucketStart),
                count: p.count,
                secondary: p.failures,
                secondaryLabel: "failures",
              }))}
              emptyLabel="No AI calls in this window."
            />
            <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
              usage_events is pruned at 180 days, so this window cannot reach further back.
            </p>
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Where incomplete accounts are parked">
            {parking.onboardingParking.length === 0 && parking.wizardParking.length === 0 ? (
              <EmptyState>Nobody is mid-onboarding.</EmptyState>
            ) : (
              <>
                {parking.onboardingParking.length > 0 && (
                  <MiniBars
                    rows={parking.onboardingParking.map((x) => ({
                      label: `tour \u00b7 ${x.step}`,
                      count: x.count,
                    }))}
                  />
                )}
                {parking.wizardParking.length > 0 && (
                  <div className="mt-3">
                    <MiniBars
                      rows={parking.wizardParking.map((x) => ({
                        label: `wizard \u00b7 ${x.step}`,
                        count: x.count,
                      }))}
                    />
                  </div>
                )}
              </>
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              The tour auto-advances every 7 seconds, so its step records where the tab was
              closed rather than what held attention. Wizard steps are validated on write,
              so those reflect a real choice — the branch taken is the signal worth acting on.
            </p>
          </AdminPanel>

          <AdminPanel title="Waitlist">
            {!waitlist ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : waitlist.total === 0 ? (
              <EmptyState>
                No signups recorded. These arrive on the Clerk waitlistEntry.created
                webhook, which must also be enabled on the endpoint in the Clerk Dashboard.
              </EmptyState>
            ) : (
              <>
                <MetricTile label="Signups" value={waitlist.total} />
                <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-sm">
                  {waitlist.recent.map((w, i) => (
                    <li key={i} className="flex justify-between gap-4">
                      <span className="truncate">{w.email ?? "\u2014"}</span>
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

        <AdminPanel title="Data quality">
          {/* A section rather than a screen: at this scale it is eight integers and most
              are zero. Split it out when two rows stay non-zero for a week — at that point
              they have stopped being checks and become work. */}
          <AdminTable
            head={
              <>
                <Th>Check</Th>
                <Th numeric>Affected</Th>
                <Th>Note</Th>
              </>
            }
          >
            {quality.map((row) => (
              <tr key={row.label} className="border-b border-border/40 last:border-b-0">
                <Td>{row.label}</Td>
                <Td
                  numeric
                  className={row.count > 0 ? "text-destructive" : "text-muted-foreground"}
                >
                  {row.count}
                  {row.total ? (
                    <span className="text-muted-foreground"> / {row.total}</span>
                  ) : null}
                </Td>
                <Td className="text-xs text-muted-foreground">{row.hint ?? ""}</Td>
              </tr>
            ))}
          </AdminTable>
        </AdminPanel>
      </div>
    </>
  );
}
