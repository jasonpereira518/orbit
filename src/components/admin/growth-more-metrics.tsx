import {
  AdminPanel,
  AdminTable,
  EmptyState,
  Td,
  Th,
} from "@/components/admin/primitives";
import { TimeSeriesChart } from "@/components/admin/growth-charts";
import {
  ArtifactsPanel,
  DataQualityPanel,
  FunnelParkingPanel,
} from "@/components/admin/product-health-panels";
import {
  aiOperationCosts,
  aiWeeklyUsage,
  consistentUsersTrend,
  workflowStagesTrend,
} from "@/lib/admin-trends";
import { formatMicros } from "@/lib/format-money";
import { longLabel, shortLabel } from "@/lib/growth-range";

/** Everything in this section is weekly over a fixed window, whatever the range above says. */
const WEEKS = 12;

const weekLabels = (points: Array<{ bucketStart: Date }>) => ({
  labels: points.map((p) => shortLabel(p.bucketStart, "week")),
  titles: points.map((p) => longLabel(p.bucketStart, "week")),
});

const dollars = (micros: number) => Math.round(micros / 10_000) / 100;

/**
 * The "More metrics" drawer at the foot of `/admin/growth`.
 *
 * Detail rather than headline: where each week's signups have got to, who keeps coming
 * back, what the AI is costing, and the row counts and data checks behind it all. It sits
 * in a closed `<details>` behind its own Suspense boundary, so none of these queries hold up
 * the charts above — the page paints, and this streams in underneath.
 *
 * Fixed at twelve weeks rather than following the range picker: "by week" is the question
 * every panel here answers, and daily AI cost or monthly consistency would answer a
 * different one. The artifact and data-quality panels are the same components Health
 * renders; they are shared, not copied.
 */
export async function GrowthMoreMetrics() {
  const [stages, consistency, aiWeeks, aiOps] = await Promise.all([
    workflowStagesTrend("week", WEEKS).catch(() => null),
    consistentUsersTrend(WEEKS).catch(() => null),
    aiWeeklyUsage(WEEKS).catch(() => null),
    aiOperationCosts(WEEKS * 7).catch(() => null),
  ]);

  const unpriced = aiWeeks?.reduce((sum, p) => sum + p.unpriced, 0) ?? 0;
  const orbitTotal = aiWeeks?.reduce((sum, p) => sum + p.orbitMicros, 0) ?? 0;
  const userTotal = aiWeeks?.reduce((sum, p) => sum + p.userMicros, 0) ?? 0;

  return (
    <div className="space-y-6">
      <AdminPanel title="Where each week's signups are now">
        {!stages ? (
          <EmptyState>Workflow stages are unavailable.</EmptyState>
        ) : (
          <TimeSeriesChart
            {...weekLabels(stages)}
            bucketHeading="Signup week"
            ariaLabel="Accounts by the furthest workflow stage they have reached, grouped by signup week."
            emptyLabel="No signups in the last 12 weeks."
            notes={stages.map((p) => [
              {
                label: "Signed up",
                value: (
                  p.signedUp +
                  p.onboarded +
                  p.hasContacts +
                  p.loggedActivity +
                  p.cameBack
                ).toLocaleString(),
              },
            ])}
            plots={[
              {
                mark: "stacked",
                height: 200,
                series: [
                  {
                    key: "signedUp",
                    label: "Signed up only",
                    color: "var(--series-2)",
                    values: stages.map((p) => p.signedUp),
                  },
                  {
                    key: "onboarded",
                    label: "Onboarded",
                    color: "var(--series-4)",
                    values: stages.map((p) => p.onboarded),
                  },
                  {
                    key: "hasContacts",
                    label: "Has contacts",
                    color: "var(--series-5)",
                    values: stages.map((p) => p.hasContacts),
                  },
                  {
                    key: "logged",
                    label: "Logged activity",
                    color: "var(--series-3)",
                    values: stages.map((p) => p.loggedActivity),
                  },
                  {
                    key: "cameBack",
                    label: "Came back",
                    color: "var(--series-1)",
                    values: stages.map((p) => p.cameBack),
                  },
                ],
              },
            ]}
          />
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Each bar is one week&apos;s signups, split by the furthest step each account has
          reached today: onboarding, adding contacts, logging a capture, note or chat, and
          writing again a week or more after joining. The newest weeks always look least
          advanced — their accounts cannot have come back yet.
        </p>
      </AdminPanel>

      <div className="grid gap-6 lg:grid-cols-2">
        <AdminPanel title="Still using it consistently">
          {!consistency ? (
            <EmptyState>Activity history is unavailable.</EmptyState>
          ) : (
            <TimeSeriesChart
              {...weekLabels(consistency)}
              bucketHeading="Week"
              partialLast
              ariaLabel="Accounts active each week, and in three or four of the last four weeks."
              emptyLabel="Nobody has written anything in the last 12 weeks."
              plots={[
                {
                  mark: "line",
                  height: 200,
                  series: [
                    {
                      key: "active",
                      label: "Active that week",
                      color: "var(--series-3)",
                      values: consistency.map((p) => p.active),
                    },
                    {
                      key: "three",
                      label: "3+ of last 4 weeks",
                      color: "var(--series-2)",
                      values: consistency.map((p) => p.threeOfFour),
                    },
                    {
                      key: "four",
                      label: "All 4 weeks",
                      color: "var(--series-1)",
                      values: consistency.map((p) => p.allFour),
                    },
                  ],
                },
              ]}
            />
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Consistent means writing something in at least three of the four weeks ending
            with that one, so a single quiet week does not count as leaving.
          </p>
        </AdminPanel>

        <FunnelParkingPanel />
      </div>

      <AdminPanel
        title="AI calls and estimated cost"
        action={
          aiWeeks && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {`12 weeks: ${formatMicros(orbitTotal)} on Orbit's keys`}
            </span>
          )
        }
      >
        {!aiWeeks ? (
          <EmptyState>AI usage is unavailable.</EmptyState>
        ) : (
          <TimeSeriesChart
            {...weekLabels(aiWeeks)}
            bucketHeading="Week"
            partialLast
            ariaLabel="AI calls and estimated AI cost per week."
            emptyLabel="No AI calls in the last 12 weeks."
            notes={aiWeeks.map((p) => [
              { label: "Orbit's keys", value: formatMicros(p.orbitMicros) },
              { label: "Users' keys", value: formatMicros(p.userMicros) },
              ...(p.unpriced > 0
                ? [{ label: "Unpriced calls", value: p.unpriced.toLocaleString() }]
                : []),
            ])}
            plots={[
              {
                title: "Calls per week",
                mark: "stacked",
                height: 150,
                series: [
                  {
                    key: "ok",
                    label: "Succeeded",
                    color: "var(--series-3)",
                    values: aiWeeks.map((p) => p.calls - p.failures),
                  },
                  {
                    key: "failed",
                    label: "Failed",
                    color: "var(--destructive)",
                    values: aiWeeks.map((p) => p.failures),
                  },
                ],
              },
              {
                title: "Estimated cost per week (USD)",
                mark: "stacked",
                height: 120,
                decimals: 2,
                series: [
                  {
                    key: "orbit",
                    label: "Orbit's keys",
                    color: "var(--series-1)",
                    values: aiWeeks.map((p) => dollars(p.orbitMicros)),
                  },
                  {
                    key: "user",
                    label: "Users' own keys",
                    color: "var(--series-4)",
                    values: aiWeeks.map((p) => dollars(p.userMicros)),
                  },
                ],
              },
            ]}
          />
        )}

        <div className="mt-5 border-t border-border/60 pt-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Most-used operations, last 12 weeks
          </div>
          {!aiOps ? (
            <EmptyState>AI usage is unavailable.</EmptyState>
          ) : aiOps.length === 0 ? (
            <EmptyState>No AI operations recorded.</EmptyState>
          ) : (
            <AdminTable
              minWidth="sm"
              head={
                <>
                  <Th>Operation</Th>
                  <Th numeric>Calls</Th>
                  <Th numeric>Accounts</Th>
                  <Th numeric>Failed</Th>
                  <Th numeric>Est. cost</Th>
                  <Th numeric>Orbit pays</Th>
                </>
              }
            >
              {aiOps.slice(0, 12).map((row) => (
                <tr key={row.operation} className="border-b border-border/40 last:border-b-0">
                  <Td className="font-mono text-xs">{row.operation}</Td>
                  <Td numeric>{row.calls.toLocaleString()}</Td>
                  <Td numeric className="text-muted-foreground">
                    {row.users}
                  </Td>
                  <Td
                    numeric
                    className={row.failures > 0 ? "text-destructive" : "text-muted-foreground"}
                  >
                    {row.failures}
                  </Td>
                  <Td numeric>{formatMicros(row.micros)}</Td>
                  <Td numeric className="text-muted-foreground">
                    {formatMicros(row.orbitMicros)}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          {/* One string, not JSX text: a line break next to an expression drops the
              space between them. */}
          {`Estimates use each model's list price at call time. "Orbit's keys" is managed-key spend Orbit pays for; users' own keys (${formatMicros(userTotal)} over 12 weeks) are billed to them and shown for scale.`}
          {unpriced > 0 &&
            ` ${unpriced.toLocaleString()} call${unpriced === 1 ? "" : "s"} used a model with no known price and ${unpriced === 1 ? "is" : "are"} not in these totals.`}
        </p>
      </AdminPanel>

      <div className="grid gap-6 lg:grid-cols-2">
        <ArtifactsPanel />
        <DataQualityPanel />
      </div>
    </div>
  );
}
