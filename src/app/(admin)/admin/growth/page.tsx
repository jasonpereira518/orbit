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
  getDataQuality,
  getFunnelParking,
  getWaitlist,
} from "@/lib/admin-product-health";

export const metadata = { title: "Admin · Growth" };

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
  ]);

  const label = (d: Date) =>
    grain === "month"
      ? d.toISOString().slice(0, 7)
      : d.toISOString().slice(5, 10);

  const totalSignups = signups.reduce((a, p) => a + p.count, 0);
  const latestActive = actives.at(-1)?.count ?? 0;

  const grainLink = (value: Grain) => (
    <a
      href={`/admin/growth${value === "week" ? "" : "?grain=month"}`}
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
        title="Growth"
        subtitle={
          <>
            <span className="tabular-nums">{totalSignups}</span> signup
            {totalSignups === 1 ? "" : "s"} in the last {buckets} {grain}s ·{" "}
            <span className="tabular-nums">{latestActive}</span> account
            {latestActive === 1 ? "" : "s"} active this {grain}
          </>
        }
      />

      <div className="space-y-6">
        <div className="flex items-center gap-3 text-xs">
          {grainLink("week")}
          <span className="text-muted-foreground/40">·</span>
          {grainLink("month")}
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
