import { Activity } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { GrowthTabs } from "@/components/admin/admin-tabs";
import { FunnelParkingPanel } from "@/components/admin/product-health-panels";
import { describeActivation } from "@/lib/activity";
import { activationTrend, firstSignupAt } from "@/lib/admin-trends";
import { formatRate } from "@/lib/format-rate";
import { longLabel, resolveGrowthWindow } from "@/lib/growth-range";
import {
  aiFirstCliff,
  cohortActivation,
  pathBreakdown,
  waveTable,
  week2Return,
} from "@/lib/product-metrics";
import { cn } from "@/lib/utils";
import { GrowthWindowNav } from "../range-nav";

export const metadata = { title: "Admin · Growth · Activation" };

/**
 * Activation: do new accounts get going, and is the next invite wave safe to send?
 *
 * The wave table reads left to right as the path a person takes: invited, let in, ready to
 * use AI, activated, back in week two. Every figure is a count with its denominator; a
 * percentage appears only once there are thirty to divide by.
 *
 * Definitions: TRACKING_PLAN.md §1-2. The thresholds that turn this into a go/no-go are in
 * ANALYTICS_PLAN.md §3.2, and are deliberately NOT drawn on the page: they are the founder's
 * to set, and a colour that says "go" would make them look like facts.
 *
 * The tiles, waves, paths and the first cliff are fixed rolling windows; only "Activation by
 * signup cohort" follows `?range=` and `?grain=`.
 */
export default async function AdminActivationPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; grain?: string }>;
}) {
  const params = await searchParams;
  const now = new Date();
  const first = await firstSignupAt().catch(() => null);
  const { range, grain, buckets, spanDays } = resolveGrowthWindow(params, first);

  const [activation, week2, trend, waves, paths, cliff] = await Promise.all([
    cohortActivation(now, 14, 7),
    week2Return(now, 28, 14),
    activationTrend(grain, buckets),
    waveTable(now),
    pathBreakdown(now, 28),
    aiFirstCliff(now),
  ]);

  return (
    <>
      <AdminPageHeader
        title="Growth"
        subtitle="Do new accounts get going, and is the next invite wave safe to send?"
      />

      <GrowthTabs />

      <div className="space-y-6">
        <GrowthWindowNav
          base="/admin/growth/activation"
          range={range}
          grain={grain}
          spanDays={spanDays}
          first={first}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <MetricTile
            label="Activated"
            value={formatRate(activation.activated, activation.size)}
            hint="accounts that finished their first week last week"
            icon={Activity}
          />
          <MetricTile
            label="Back in week two"
            value={formatRate(week2.activated, week2.size)}
            hint="accounts that have reached two weeks"
            icon={Activity}
          />
        </div>

        <AdminPanel title="Activation by signup cohort">
          {trend.every((p) => p.signed === 0) ? (
            <EmptyState>No signups in this window.</EmptyState>
          ) : (
            <AdminTable label="Activation by signup cohort"
              minWidth="sm"
              head={
                <>
                  <Th>Joined</Th>
                  <Th numeric>Signed up</Th>
                  <Th numeric>Onboarded</Th>
                  <Th numeric>Added a contact</Th>
                  <Th numeric>Activated</Th>
                </>
              }
            >
              {/* Newest first, and only periods anyone joined in — at daily grain the
                  empty days would bury the ones that matter. */}
              {[...trend]
                .reverse()
                .filter((p) => p.signed > 0)
                .map((p) => (
                  <tr
                    key={p.bucketStart.toISOString()}
                    className="border-b border-border/40 last:border-b-0"
                  >
                    <Td className="tabular-nums">{longLabel(p.bucketStart, grain)}</Td>
                    <Td numeric>{p.signed}</Td>
                    <Td numeric className={cn(p.onboarded === 0 && "text-destructive")}>
                      {formatRate(p.onboarded, p.signed)}
                    </Td>
                    <Td numeric>{formatRate(p.firstContact, p.signed)}</Td>
                    <Td numeric>
                      {/* Only accounts old enough to have had the whole window can be judged. */}
                      {p.matured === 0 ? "—" : formatRate(p.activated, p.matured)}
                    </Td>
                  </tr>
                ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
            {describeActivation()} Internal and tester accounts are left out.
          </p>
        </AdminPanel>

        <AdminPanel title="Invite waves">
          {waves.length === 0 ? (
            <EmptyState>
              No wave has been recorded. Send an invite with a wave label from Access and it appears here.
            </EmptyState>
          ) : (
            <AdminTable
              label="Invite waves"
              minWidth="sm"
              head={
                <>
                  <Th>Wave</Th>
                  <Th numeric>Invited</Th>
                  <Th numeric>Joined</Th>
                  <Th numeric>AI ready in a day</Th>
                  <Th numeric>Activated</Th>
                  <Th numeric>Back in week two</Th>
                </>
              }
            >
              {waves.map((w) => (
                <tr key={w.waveId} className="border-b border-border/40 last:border-b-0">
                  <Td>
                    {w.waveId}
                    {w.firstSentAt && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        <RelativeTime date={w.firstSentAt} />
                      </span>
                    )}
                  </Td>
                  <Td numeric>{w.invited}</Td>
                  <Td numeric>{formatRate(w.accepted, w.invited)}</Td>
                  <Td numeric>{formatRate(w.aiReady24h, w.accepted)}</Td>
                  <Td numeric>{w.matured === 0 ? "—" : formatRate(w.activated, w.matured)}</Td>
                  <Td numeric>{w.matured === 0 ? "—" : formatRate(w.returnedWeek2, w.matured)}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
            Activation and week-two return are judged only for accounts at least two weeks old, so a
            fresh wave reads “—” rather than a miss.
          </p>
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Activation by onboarding path · last 28 days">
            {paths.length === 0 ? (
              <EmptyState>No sign-ups in this window.</EmptyState>
            ) : (
              <AdminTable
                label="Activation by onboarding path"
                minWidth="sm"
                head={
                  <>
                    <Th>Path</Th>
                    <Th numeric>Accounts</Th>
                    <Th numeric>Activated</Th>
                  </>
                }
              >
                {paths.map((p) => (
                  <tr key={p.path} className="border-b border-border/40 last:border-b-0">
                    <Td>{p.path}</Td>
                    <Td numeric>{p.accounts}</Td>
                    <Td numeric>{p.matured === 0 ? "—" : formatRate(p.activated, p.matured)}</Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </AdminPanel>

          <AdminPanel title="The first cliff">
            <p className="py-1 text-sm">
              <span className="text-2xl tabular-nums">{formatRate(cliff.stuck, cliff.eligible)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              accounts a day to a month old that have neither added their own AI key nor had a single AI call
              succeed. If this is large, the key step is where people are leaving.
            </p>
          </AdminPanel>
        </div>

        {/* The cohort table says how many made it; this says where the rest stopped. Current
            state, not the selected range — an account parked at step 2 is parked now. */}
        <FunnelParkingPanel />
      </div>
    </>
  );
}
