import Link from "next/link";
import { AlertTriangle, Clock } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  CodeDetail,
  EmptyState,
  MetricTile,
  MiniBars,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { SystemStrip } from "@/components/admin/system-strip";
import {
  getOpsAiFailures,
  getOpsBugSignatures,
  getOpsCalendar,
  getOpsConnections,
  getOpsCron,
  getOpsErrors,
  getOpsImports,
  getOpsOutreachQueue,
  getOpsWebhooks,
  type StuckImport,
} from "@/lib/admin-ops";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Ops" };

/**
 * What is going on, and what is stuck.
 *
 * The split against the Overview is strict: **this screen names systems, the Overview names
 * people.** If the fix is "message this user" it belongs in `buildAlerts`; if the fix is
 * "go fix Orbit" it belongs here. Nothing on this page calls `buildAlerts`.
 *
 * There are deliberately NO action buttons. There is no server-side resume for
 * client-driven imports and no runner for scheduled outreach, so any "Retry" would either
 * be a no-op or require building the runner first. Ops is a mirror, not a control panel.
 *
 * Trends here attach to events (AI calls per day), never to accounts — at this scale an
 * account trend is noise, while a single user generates dozens of AI calls a day.
 */
export default async function AdminOpsPage() {
  // Each new-instrumentation loader degrades independently, so this page was useful before
  // cron_runs / error_events / webhook_deliveries existed and stays useful if one breaks.
  const [
    importsState,
    outreach,
    connections,
    calendar,
    cron,
    ai,
    errors,
    webhooks,
    bugs,
  ] = await Promise.all([
    getOpsImports(),
    getOpsOutreachQueue(),
    getOpsConnections(),
    getOpsCalendar(),
    getOpsCron().catch(() => null),
    getOpsAiFailures(),
    getOpsErrors().catch(() => null),
    getOpsWebhooks().catch(() => null),
    getOpsBugSignatures(),
  ]);

  const totalFailures =
    ai.ours.reduce((a, r) => a + r.count, 0) + ai.theirs.reduce((a, r) => a + r.count, 0);

  return (
    <>
      <AdminPageHeader
        title="Ops"
        subtitle={
          <>
            <span className="tabular-nums">{importsState.wedged.length}</span> wedged ·{" "}
            <span className="tabular-nums">{outreach.overdue}</span> overdue sends ·{" "}
            <span className="tabular-nums">{connections.needsReauth}</span> connections
            need reauth
          </>
        }
      />

      <SystemStrip
        items={[
          {
            label: "Cron",
            value: cron?.lastRun
              ? cron.missed
                ? "has not run in over a day"
                : `${cron.lastRun.state} · ${new Date(cron.lastRun.startedAt).toISOString().slice(5, 16).replace("T", " ")}`
              : "no runs recorded",
            tone: !cron?.lastRun || cron.missed
              ? "danger"
              : cron.lastRun.state === "ok"
                ? "ok"
                : "warn",
          },
          {
            label: "Search index",
            value:
              bugs.embeddingsMissingVector === null
                ? "pgvector unavailable"
                : `${bugs.embeddingsMissingVector} unindexed`,
            tone:
              bugs.embeddingsMissingVector && bugs.embeddingsMissingVector > 0
                ? "warn"
                : "ok",
          },
          {
            label: "AI failures (7d)",
            value: `${totalFailures} of ${ai.totalCalls}`,
            tone: totalFailures > 0 ? "warn" : "ok",
          },
          {
            label: "Webhooks (7d)",
            value: webhooks
              ? webhooks.byOutcome.map((o) => `${o.count} ${o.outcome}`).join(" · ") ||
                "none"
              : "not instrumented",
            tone: webhooks?.byOutcome.some(
              (o) => o.outcome === "invalid" || o.outcome === "error"
            )
              ? "danger"
              : "ok",
          },
        ]}
      />

      <div className="space-y-6">
        <AdminPanel title="Stuck work">
          <div className="space-y-5">
            <StuckGroup
              heading="Wedged — nothing will recover these"
              caption="Client-driven imports. The nightly cron filters on import_type, so it never
                       touches these; closing the tab wedges them permanently."
              rows={importsState.wedged}
              planBlocked={importsState.planBlockedByImport}
              tone="danger"
            />
            <StuckGroup
              heading="Waiting for the cron — self-heals"
              caption="Server-owned. The backstop runs once a day, so expect up to 24h before
                       these resume."
              rows={importsState.awaitingCron}
              planBlocked={importsState.planBlockedByImport}
              tone="warn"
            />
            <StuckGroup
              heading="Failed in the last 7 days — terminal"
              caption="There is no retry path for a failed import anywhere in the product."
              rows={importsState.failed}
              planBlocked={importsState.planBlockedByImport}
              tone="danger"
            />
          </div>
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Scheduled outreach">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Overdue"
                value={outreach.overdue}
                tone={outreach.overdue > 0 ? "danger" : "default"}
                hint={
                  outreach.oldestOverdueDays !== null
                    ? `oldest ${outreach.oldestOverdueDays}d`
                    : undefined
                }
              />
              <MetricTile
                label="Not yet due"
                value={outreach.notYetDue}
                tone="muted"
                hint={`across ${outreach.accounts} account${outreach.accounts === 1 ? "" : "s"}`}
              />
            </div>
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              This queue has no runner. It drains only when the owning user opens that
              campaign, so overdue messages accumulate silently until someone looks.
            </p>
          </AdminPanel>

          <AdminPanel title="Cron runs">
            {!cron || cron.recent.length === 0 ? (
              <EmptyState>
                No runs recorded yet. The ledger starts at the next midnight run.
              </EmptyState>
            ) : (
              <AdminTable
                head={
                  <>
                    <Th>Started</Th>
                    <Th>State</Th>
                    <Th numeric>Took</Th>
                    <Th>Result</Th>
                  </>
                }
              >
                {cron.recent.map((run) => (
                  <tr key={run.id} className="border-b border-border/40 last:border-b-0">
                    <Td className="text-muted-foreground">
                      <RelativeTime date={run.startedAt} /> ago
                    </Td>
                    <Td
                      className={cn(
                        (run.state === "failed" || run.state === "stale") &&
                          "text-destructive",
                        run.state === "partial" && "text-accent-foreground"
                      )}
                    >
                      {run.state}
                    </Td>
                    <Td numeric>
                      {run.durationMs === null ? "—" : `${Math.round(run.durationMs / 1000)}s`}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {run.error ??
                        Object.entries(run.stats)
                          .filter(([, v]) => typeof v === "number" && v > 0)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(" · ") ??
                        "—"}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </AdminPanel>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Connections">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Need reauth"
                value={connections.needsReauth}
                tone={connections.needsReauth > 0 ? "danger" : "default"}
              />
              <MetricTile label="Healthy" value={connections.healthy} tone="muted" />
            </div>
            {connections.byProvider.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-sm">
                {connections.byProvider.map((r) => (
                  <li
                    key={`${r.provider}-${r.status}`}
                    className="flex justify-between gap-4"
                  >
                    <span className="text-muted-foreground">
                      {r.provider} · {r.status}
                    </span>
                    <span className="tabular-nums">{r.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </AdminPanel>

          <AdminPanel title="Calendar feeds">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Erroring"
                value={calendar.erroring}
                tone={calendar.erroring > 0 ? "danger" : "default"}
              />
              <MetricTile
                label="Never synced"
                value={calendar.neverSynced}
                tone="muted"
              />
            </div>
            {calendar.stale.length > 0 && (
              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Stale over 7 days ({calendar.stale.length})
                </div>
                <ul className="mt-1.5 space-y-1 text-sm">
                  {calendar.stale.slice(0, 6).map((s) => (
                    <li key={s.userId} className="flex justify-between gap-4">
                      <span className="truncate">{s.email ?? s.userId}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        owner last seen{" "}
                        {s.ownerLastSeen ? (
                          <>
                            <RelativeTime date={s.ownerLastSeen} /> ago
                          </>
                        ) : (
                          "never"
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {/* Sync only fires when someone loads the dashboard or imports page, so a
                    stale feed is nearly always an inactive user rather than a broken feed.
                    Showing last-seen turns an alarming number into a true one. */}
                <p className="mt-2 text-xs text-muted-foreground">
                  Sync runs only when a user loads the dashboard or imports page, so a
                  stale feed usually means an inactive owner, not a broken feed.
                </p>
              </div>
            )}
            {calendar.recentErrors.length > 0 && (
              <div className="mt-3 border-t border-border/60 pt-3">
                {calendar.recentErrors.map((e, i) => (
                  <div key={i}>
                    <div className="text-sm">{e.label ?? "feed"}</div>
                    <CodeDetail>{e.error}</CodeDetail>
                  </div>
                ))}
              </div>
            )}
          </AdminPanel>
        </div>

        <AdminPanel title={`AI failures (7 days, ${ai.totalCalls} calls)`}>
          {ai.ours.length === 0 && ai.theirs.length === 0 ? (
            <EmptyState>No AI calls have failed.</EmptyState>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                {/* This grouping IS the decision. `auth` spiking means users have bad keys,
                    which is already a person-alert on the Overview. `timeout` spiking
                    means Orbit broke. */}
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Ours — Orbit broke
                </div>
                <div className="mt-2">
                  {ai.ours.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None.</p>
                  ) : (
                    <MiniBars rows={ai.ours.map((r) => ({ label: r.kind, count: r.count }))} />
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Theirs — the user&apos;s key or quota
                </div>
                <div className="mt-2">
                  {ai.theirs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None.</p>
                  ) : (
                    <MiniBars
                      rows={ai.theirs.map((r) => ({ label: r.kind, count: r.count }))}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
          {ai.slowest.length > 0 && (
            <div className="mt-4 border-t border-border/60 pt-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Slowest operations (max, not average — max is what users notice)
              </div>
              <ul className="mt-1.5 space-y-1 text-sm">
                {ai.slowest.map((s) => (
                  <li key={s.operation} className="flex justify-between gap-4">
                    <span className="font-mono text-xs">{s.operation}</span>
                    <span className="tabular-nums">
                      {(s.maxMs / 1000).toFixed(1)}s
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Error events (7 days)">
            {!errors ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : errors.grouped.length === 0 ? (
              <EmptyState>Nothing has failed silently.</EmptyState>
            ) : (
              <>
                <MiniBars
                  rows={errors.grouped.map((g) => ({
                    label: `${g.source} · ${g.kind}`,
                    count: g.count,
                  }))}
                />
                <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
                  {errors.recent.slice(0, 6).map((e, i) => (
                    <div key={i}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="font-mono text-xs">
                          {e.source} · {e.kind}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <RelativeTime date={e.at} /> ago
                        </span>
                      </div>
                      <CodeDetail>{e.message}</CodeDetail>
                    </div>
                  ))}
                </div>
              </>
            )}
          </AdminPanel>

          <AdminPanel title="Webhooks (7 days)">
            {!webhooks ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : webhooks.byOutcome.length === 0 ? (
              <EmptyState>No deliveries recorded.</EmptyState>
            ) : (
              <>
                <MiniBars
                  rows={webhooks.byOutcome.map((o) => ({
                    label: o.outcome,
                    count: o.count,
                  }))}
                />
                {webhooks.ignored.length > 0 && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Arrived but ignored
                    </div>
                    <ul className="mt-1.5 space-y-1 text-sm">
                      {webhooks.ignored.map((r, i) => (
                        <li key={i} className="flex justify-between gap-4">
                          <span className="font-mono text-xs">
                            {r.eventType ?? "—"} · {r.reason ?? "—"}
                          </span>
                          <span className="tabular-nums">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {webhooks.retried.length > 0 && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-destructive">
                      <AlertTriangle className="size-3" aria-hidden />
                      Redelivered — the handler is failing
                    </div>
                    <ul className="mt-1.5 space-y-1 text-xs">
                      {webhooks.retried.map((r) => (
                        <li key={r.eventId} className="flex justify-between gap-4">
                          <span className="truncate font-mono">{r.eventId}</span>
                          <span className="tabular-nums">×{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {webhooks.recentInvalid.length > 0 && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Rejected signatures
                    </div>
                    {webhooks.recentInvalid.slice(0, 3).map((r, i) => (
                      <CodeDetail key={i}>{r.error}</CodeDetail>
                    ))}
                  </div>
                )}
              </>
            )}
          </AdminPanel>
        </div>

        <AdminPanel title="Known bug signatures">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile
              label="Confirmed, no reminder"
              value={bugs.confirmedWithoutReminder}
              tone={bugs.confirmedWithoutReminder > 0 ? "danger" : "muted"}
              hint="a confirm that half-committed"
            />
            <MetricTile
              label="Unindexed embeddings"
              value={
                bugs.embeddingsMissingVector === null
                  ? "—"
                  : bugs.embeddingsMissingVector
              }
              tone={
                bugs.embeddingsMissingVector && bugs.embeddingsMissingVector > 0
                  ? "danger"
                  : "muted"
              }
              hint="invisible to semantic search"
            />
            <MetricTile
              label="Inlined avatars"
              value={bugs.inlinedAvatars}
              tone={bugs.inlinedAvatars > 0 ? "danger" : "muted"}
              hint="base64 in Postgres — Blob unset"
            />
          </div>
        </AdminPanel>
      </div>
    </>
  );
}

function StuckGroup({
  heading,
  caption,
  rows,
  planBlocked,
  tone,
}: {
  heading: string;
  caption: string;
  rows: StuckImport[];
  planBlocked: Map<string, number>;
  tone: "danger" | "warn";
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h3
          className={cn(
            "flex items-center gap-1.5 text-sm",
            rows.length > 0 && tone === "danger" && "text-destructive",
            rows.length > 0 && tone === "warn" && "text-accent-foreground"
          )}
        >
          {rows.length > 0 &&
            (tone === "danger" ? (
              <AlertTriangle className="size-3.5" aria-hidden />
            ) : (
              <Clock className="size-3.5" aria-hidden />
            ))}
          {heading}
        </h3>
        <span className="shrink-0 text-sm tabular-nums">{rows.length}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>

      {rows.length > 0 && (
        <div className="mt-2">
          <AdminTable
            head={
              <>
                <Th>Account</Th>
                <Th>Type</Th>
                <Th numeric>Progress</Th>
                <Th numeric>Stuck for</Th>
                <Th>Detail</Th>
              </>
            }
          >
            {rows.map((row) => {
              const blocked = planBlocked.get(row.id) ?? 0;
              return (
                <tr key={row.id} className="border-b border-border/40 last:border-b-0">
                  <Td>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.userId)}`}
                      className="hover:text-primary"
                    >
                      {row.email ?? row.userId}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{row.importType}</Td>
                  <Td numeric>
                    {row.rowsProcessed ?? 0}
                    {row.totalRows ? ` / ${row.totalRows}` : ""}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.updatedAt} />
                  </Td>
                  <Td>
                    {blocked > 0 && (
                      <span className="text-accent-foreground">
                        {blocked} row{blocked === 1 ? "" : "s"} hit the plan cap — upgrade
                        signal, not an error
                      </span>
                    )}
                    <CodeDetail>{row.errorMessage}</CodeDetail>
                  </Td>
                </tr>
              );
            })}
          </AdminTable>
        </div>
      )}
    </div>
  );
}
