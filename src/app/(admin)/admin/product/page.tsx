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
  TrendTable,
} from "@/components/admin/primitives";
import { loadAdminUserRows } from "@/lib/admin-metrics";
import { getProductSnapshot, timeToFirstContact } from "@/lib/admin-product";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Product" };

/**
 * Is the product actually being used, and is the data healthy?
 *
 * Trends live here rather than on the Overview, and they attach to EVENTS, never to
 * accounts. Signups per week at this scale is `0,1,0,0,2,1,0` — noise rendered as a shape.
 * AI calls per week runs to hundreds even with a dozen users, so its shape means something.
 *
 * Rendered as a table rather than a sparkline on purpose: a sparkline autoscales, so noise
 * fills the frame and a quiet week looks dramatic. Printed integers read honestly.
 */
export default async function AdminProductPage() {
  const [snapshot, rows] = await Promise.all([
    getProductSnapshot(),
    loadAdminUserRows(),
  ]);

  const activation = timeToFirstContact(rows);
  const activeUsers = new Set(snapshot.adoption.flatMap((a) => (a.users > 0 ? [a.operation] : [])));

  return (
    <>
      <AdminPageHeader
        title="Product"
        subtitle={
          <>
            <span className="tabular-nums">{rows.length}</span> accounts ·{" "}
            <span className="tabular-nums">{activeUsers.size}</span> features used in 30d ·{" "}
            <span
              className={cn(
                "tabular-nums",
                snapshot.neverUsed.length > 0 && "text-foreground"
              )}
            >
              {snapshot.neverUsed.length}
            </span>{" "}
            never used
          </>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Feature adoption (30 days)">
            {snapshot.adoption.length === 0 ? (
              <EmptyState>No AI operations recorded yet.</EmptyState>
            ) : (
              <AdminTable
                head={
                  <>
                    <Th>Operation</Th>
                    <Th numeric>Users</Th>
                    <Th numeric>Calls</Th>
                    <Th numeric>Failed</Th>
                  </>
                }
              >
                {snapshot.adoption.map((row) => (
                  <tr
                    key={row.operation}
                    className="border-b border-border/40 last:border-b-0"
                  >
                    <Td className="font-mono text-xs">{row.operation}</Td>
                    {/* Sorted by users, not calls: one power user making 400 chat calls is
                        intensity, not adoption. */}
                    <Td numeric>{row.users}</Td>
                    <Td numeric className="text-muted-foreground">
                      {row.calls}
                    </Td>
                    <Td
                      numeric
                      className={row.failures > 0 ? "text-destructive" : "text-muted-foreground"}
                    >
                      {row.failures}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}

            {snapshot.neverUsed.length > 0 && (
              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Never used in this window
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {snapshot.neverUsed.join(", ")}
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Absent operations produce no group, so this is diffed against the known
                  call sites rather than read from the data. Usage events prune at 180 days.
                </p>
              </div>
            )}
          </AdminPanel>

          <AdminPanel title="Durable artifacts">
            {/* Catches what usage_events structurally cannot: reminders, tags, goals and
                the graph leave no AI call behind. */}
            <AdminTable
              head={
                <>
                  <Th>Table</Th>
                  <Th numeric>Rows</Th>
                  <Th numeric>Accounts</Th>
                </>
              }
            >
              {snapshot.artifacts.map((a) => (
                <tr key={a.label} className="border-b border-border/40 last:border-b-0">
                  <Td>{a.label}</Td>
                  <Td numeric className={a.rows === 0 ? "text-muted-foreground" : undefined}>
                    {a.rows}
                  </Td>
                  <Td numeric className="text-muted-foreground">
                    {a.users || "—"}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          </AdminPanel>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Onboarding — where incomplete accounts are parked">
            {snapshot.onboardingParking.length === 0 ? (
              <EmptyState>No accounts are mid-onboarding.</EmptyState>
            ) : (
              <MiniBars
                rows={snapshot.onboardingParking.map((p) => ({
                  label: p.step,
                  count: p.count,
                }))}
              />
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              The tour auto-advances every 7 seconds, so this records where the tab was
              closed — not what the person engaged with. Read it as attention span, not
              interest.
            </p>
          </AdminPanel>

          <AdminPanel title="Wizard">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile label="Completed" value={snapshot.wizardCompleted} />
              <MetricTile
                label="Abandoned"
                value={snapshot.wizardParking.reduce((a, p) => a + p.count, 0)}
                tone="muted"
              />
            </div>
            {snapshot.wizardParking.length > 0 && (
              <div className="mt-3 border-t border-border/60 pt-3">
                <MiniBars
                  rows={snapshot.wizardParking.map((p) => ({
                    label: p.step,
                    count: p.count,
                  }))}
                />
              </div>
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Unlike the tour, wizard steps are validated on write, so these reflect a real
              choice. The branch — manual, capture or import — is the signal worth acting on.
            </p>
          </AdminPanel>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Time to first contact">
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
              <MetricTile label="Under 1h" value={activation.hour} />
              <MetricTile label="Under 1d" value={activation.day} />
              <MetricTile label="Under 7d" value={activation.week} />
              <MetricTile label="Later" value={activation.later} tone="muted" />
              <MetricTile
                label="Never"
                value={activation.never}
                tone={activation.never > 0 ? "danger" : "muted"}
              />
            </div>
          </AdminPanel>

          <AdminPanel title="Waitlist">
            {!snapshot.waitlist ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : snapshot.waitlist.total === 0 ? (
              <EmptyState>
                No waitlist signups recorded. These arrive via the Clerk
                <code className="mx-1 font-mono text-xs">waitlistEntry.created</code>
                webhook, which must be enabled on the endpoint in the Clerk Dashboard.
              </EmptyState>
            ) : (
              <>
                <MetricTile label="Signups" value={snapshot.waitlist.total} />
                <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-sm">
                  {snapshot.waitlist.recent.map((w, i) => (
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

        <AdminPanel title="Data quality">
          {/*
            A section here rather than its own screen: at this scale it is eight integers
            and most of them are zero, and a screen rendering eight zeros is vanity.
            Split it out when two rows stay non-zero for a week — at that point they have
            stopped being checks and become work.
          */}
          <AdminTable
            head={
              <>
                <Th>Check</Th>
                <Th numeric>Affected</Th>
                <Th>Note</Th>
              </>
            }
          >
            {snapshot.dataQuality.map((row) => (
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

        <AdminPanel title="Last 8 weeks">
          <TrendTable
            columns={["Signups", "AI calls", "Captures", "Chats", "Contacts"]}
            rows={snapshot.weekly}
          />
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Event counts, not account counts. Signups is included for context but at this
            scale its week-to-week shape means nothing — the AI and capture columns are the
            ones with enough volume to read.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
