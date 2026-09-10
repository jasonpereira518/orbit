import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CircleCheck,
  FileClock,
  ServerCog,
  Users,
} from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  EmptyState,
  MetricTile,
  RelativeTime,
} from "@/components/admin/primitives";
import { IssueActions } from "@/components/admin/issue-actions";
import { getAdminOverview } from "@/lib/admin-metrics";
import { refreshHealthIssues, reconcileProviderIssues } from "@/lib/admin-issue-detectors";
import { listAdminIssues } from "@/lib/admin-issues";
import { loadProviderStatuses } from "@/lib/admin-providers";
import {
  getReliabilitySummary,
  loadOperationalEvents,
} from "@/lib/operational-events";
import { MONTHLY_AMOUNT } from "@/lib/plan-copy";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Command Center" };

export default async function AdminCommandCenterPage() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  const [overview, providers, , reliability, eventPage] = await Promise.all([
    getAdminOverview(),
    loadProviderStatuses(),
    refreshHealthIssues(now),
    getReliabilitySummary(dayAgo, twoDaysAgo),
    loadOperationalEvents({ since: dayAgo, limit: 12 }),
  ]);
  await reconcileProviderIssues(providers, now);
  const issues = await listAdminIssues({ limit: 40 });

  const errors = issues.filter((issue) => issue.severity === "error");
  const overall = errors.length > 0 ? "degraded" : "healthy";
  const newAccounts = overview.rows.filter((row) => row.signupAt >= dayAgo).length;
  const activeAccounts = overview.rows.filter(
    (row) => row.lastSeenAt && row.lastSeenAt >= dayAgo
  ).length;
  const vercel = providers.find((provider) => provider.provider === "vercel");

  return (
    <>
      <AdminPageHeader
        title="Command Center"
        subtitle="What needs attention, what changed, and where to act."
        action={
          <Link
            href="/admin/systems"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            System detail <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        }
      />

      <div className="space-y-6">
        <section
          className={cn(
            "flex flex-col justify-between gap-5 rounded-2xl px-5 py-5 text-primary-foreground sm:flex-row sm:items-center",
            overall === "healthy" ? "bg-primary" : "bg-[#6f3b33] dark:bg-[#713c35]"
          )}
        >
          <div className="flex items-start gap-3">
            {overall === "healthy" ? (
              <CircleCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
            )}
            <div>
              <h2 className="text-base font-medium">
                {overall === "healthy"
                  ? "Orbit is operating normally"
                  : `${errors.length} critical issue${errors.length === 1 ? "" : "s"} need attention`}
              </h2>
              <p className="mt-1 max-w-[65ch] text-sm text-primary-foreground/75">
                {issues.length === 0
                  ? "No active account, provider, job, or integration condition is currently failing."
                  : `${issues.length} active issue${issues.length === 1 ? "" : "s"} across accounts and systems.`}
              </p>
            </div>
          </div>
          {vercel && (
            <a
              href={vercel.href}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded-lg bg-primary-foreground/10 px-3 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary-foreground/15"
            >
              Production {String(vercel.metrics.deploymentState ?? vercel.status).toLowerCase()}
              {typeof vercel.metrics.commit === "string" && ` · ${vercel.metrics.commit}`}
            </a>
          )}
        </section>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile label="New accounts" value={newAccounts} hint="last 24 hours" icon={Users} />
          <MetricTile label="Active accounts" value={activeAccounts} hint="seen in 24 hours" icon={Activity} />
          <MetricTile label="MRR" value={`$${overview.plans.subscribed * MONTHLY_AMOUNT}`} hint={`${overview.plans.subscribed} subscriptions`} />
          <MetricTile
            label="Errors"
            value={reliability.failures}
            hint={`${reliability.previousFailures} in the prior 24 hours`}
            icon={AlertTriangle}
            tone={reliability.failures > 0 ? "accent" : "muted"}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.75fr)]">
          <AdminPanel
            title="Needs attention"
            action={<Link href="/admin/systems" className="text-xs text-muted-foreground hover:text-primary">All systems →</Link>}
          >
            {issues.length === 0 ? (
              <EmptyState>Nothing is waiting for you.</EmptyState>
            ) : (
              <ul className="divide-y divide-border/50">
                {issues.slice(0, 12).map((issue) => (
                  <li key={issue.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
                    <span
                      className={cn(
                        "mt-0.5 size-2 shrink-0 rounded-full sm:mt-0",
                        issue.severity === "error" ? "bg-destructive" : "bg-tier-lifetime"
                      )}
                      aria-label={issue.severity}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{issue.title}</span>
                        {issue.targetUserId && (
                          <Link
                            href={`/admin/users/${encodeURIComponent(issue.targetUserId)}`}
                            className="truncate text-xs text-muted-foreground hover:text-primary"
                          >
                            {issue.targetUserId}
                          </Link>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{issue.message}</p>
                    </div>
                    <IssueActions issueId={issue.id} />
                  </li>
                ))}
              </ul>
            )}
          </AdminPanel>

          <AdminPanel title="Quick routes">
            <nav className="space-y-1" aria-label="Command center shortcuts">
              {[
                { href: "/admin/logs?severity=error", icon: FileClock, label: "Investigate errors", detail: `${reliability.failures} in 24h` },
                { href: "/admin/users?state=missing_key", icon: Users, label: "Repair an account", detail: "Search and inspect" },
                { href: "/admin/systems", icon: ServerCog, label: "Check providers", detail: `${providers.filter((p) => p.status === "healthy").length}/4 healthy` },
                { href: "/admin/audit", icon: Activity, label: "Review changes", detail: "Privileged trail" },
              ].map((route) => (
                <Link
                  key={route.href}
                  href={route.href}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted"
                >
                  <route.icon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">{route.label}</span>
                  <span className="text-xs text-muted-foreground">{route.detail}</span>
                </Link>
              ))}
            </nav>
          </AdminPanel>
        </div>

        <AdminPanel
          title="Recent operational events"
          action={<Link href="/admin/logs" className="text-xs text-muted-foreground hover:text-primary">Open logs →</Link>}
        >
          {eventPage.rows.length === 0 ? (
            <EmptyState>No structured operational events have been recorded yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/50">
              {eventPage.rows.map((event) => (
                <li key={event.id} className="flex items-baseline gap-3 py-2 text-sm">
                  <span className={cn("w-12 shrink-0 font-mono text-xs uppercase", event.severity === "error" ? "text-destructive" : "text-muted-foreground")}>{event.severity}</span>
                  <span className="w-48 shrink-0 truncate font-mono text-xs">{event.eventType}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{event.message}</span>
                  <span className="shrink-0 text-xs text-muted-foreground"><RelativeTime date={event.occurredAt} /></span>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
