import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MiniBars,
  Td,
  Th,
  TrendBars,
} from "@/components/admin/primitives";
import {
  activationTrend,
  activeTrend,
  aiVolumeTrend,
  featureAdoption,
  retentionCohorts,
  signupTrend,
  type Grain,
} from "@/lib/admin-trends";

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

  const [signups, actives, activation, cohorts, adoption, aiVolume] =
    await Promise.all([
      signupTrend(grain, buckets),
      activeTrend(grain, buckets),
      activationTrend(grain, buckets),
      retentionCohorts(6),
      featureAdoption(),
      aiVolumeTrend(grain, buckets),
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
        </div>
      </div>
    </>
  );
}
