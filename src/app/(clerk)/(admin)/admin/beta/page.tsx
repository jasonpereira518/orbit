import Link from "next/link";
import { Activity, AlertTriangle, MessageSquareText, Users } from "lucide-react";
import { AdminPageHeader, AdminPanel, AdminTable, EmptyState, MetricTile, RelativeTime, Td, Th } from "@/components/admin/primitives";
import { describeActivation } from "@/lib/activity";
import { formatRate } from "@/lib/format-rate";
import {
  aiFirstCliff,
  cohortActivation,
  failuresTouchingUsers,
  feedbackCounts,
  newestBugs,
  pathBreakdown,
  waveTable,
  week2Return,
  weeklyActiveNetworkers,
} from "@/lib/product-metrics";

export const metadata = { title: "Admin · Beta" };
export const dynamic = "force-dynamic";

/**
 * Private beta: invite waves and activation, on one screen.
 *
 * The question this page exists to answer is "is the next wave safe to send?", so it leads
 * with the wave table, one row per invite wave, read left to right as the path a person takes:
 * invited, let in, ready to use AI, activated, back in week two. Every figure is a count with
 * its denominator; a percentage appears only once there are thirty to divide by.
 *
 * Definitions: TRACKING_PLAN.md §1-2. The thresholds that turn this into a go/no-go are in
 * ANALYTICS_PLAN.md §3.2, and are deliberately NOT drawn on the page: they are the founder's
 * to set, and a colour that says "go" would make them look like facts.
 */
export default async function AdminBetaPage() {
  const now = new Date();
  const [waves, wan, cliff, failures, feedback, bugs, paths, activation, week2] = await Promise.all([
    waveTable(now),
    weeklyActiveNetworkers(now),
    aiFirstCliff(now),
    failuresTouchingUsers(now, 7),
    feedbackCounts(now, 7),
    newestBugs(3),
    pathBreakdown(now, 28),
    cohortActivation(now, 14, 7),
    week2Return(now, 28, 14),
  ]);

  return (
    <>
      <AdminPageHeader
        title="Beta"
        subtitle="Invite waves and activation: is the next wave safe to send?"
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Active networkers"
          value={wan.current}
          hint={`${wan.previous} the week before · ${formatRate(wan.current, wan.mau)} of this month`}
          icon={Users}
        />
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
        <MetricTile
          label="Saw a failure"
          value={failures.accounts}
          hint={failures.flows.length ? failures.flows.map((f) => `${f.flow} ${f.accounts}`).join(" · ") : "this week"}
          icon={AlertTriangle}
          tone={failures.accounts > 0 ? "accent" : "muted"}
        />
      </div>

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
          fresh wave reads “—” rather than a miss. {describeActivation()}
        </p>
      </AdminPanel>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
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

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <AdminPanel
          title="Feedback this week"
          action={
            <Link href="/admin/feedback" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Open feedback
            </Link>
          }
        >
          <MetricTile
            label="This week"
            value={feedback.byCategory.reduce((n, c) => n + c.count, 0)}
            hint={`${feedback.byCategory.map((c) => `${c.category} ${c.count}`).join(" · ") || "nothing yet"} · ${feedback.unresolved} unresolved`}
            icon={MessageSquareText}
          />
          {bugs.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {bugs.map((b) => (
                <li key={b.id}>
                  <Link href={`/admin/feedback/${b.id}`} className="underline underline-offset-2 hover:text-primary">
                    Bug{b.area ? ` · ${b.area}` : ""}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">
                    <RelativeTime date={b.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>

        <AdminPanel title="Failures people saw · 7 days">
          {failures.flows.length === 0 ? (
            <EmptyState>None. Nobody hit a failed capture, import, email send or AI call this week.</EmptyState>
          ) : (
            <AdminTable
              label="Failures by flow"
              minWidth="sm"
              head={
                <>
                  <Th>Flow</Th>
                  <Th numeric>Accounts</Th>
                  <Th numeric>Failures</Th>
                </>
              }
            >
              {failures.flows.map((f) => (
                <tr key={f.flow} className="border-b border-border/40 last:border-b-0">
                  <Td>{f.flow}</Td>
                  <Td numeric>{f.accounts}</Td>
                  <Td numeric>{f.failures}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
