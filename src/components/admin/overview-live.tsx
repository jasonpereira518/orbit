"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { AlertTriangle, CircleAlert, Sparkles } from "lucide-react";
import {
  AdminPanel,
  EmptyState,
  MetricTile,
  PlanBadge,
  RelativeTime,
} from "@/components/admin/primitives";
import { useLivePoll } from "@/components/admin/use-live-poll";
import type { OverviewLiveData } from "@/lib/admin-metrics";
import { cn } from "@/lib/utils";

/**
 * Live data for `/admin` — "Needs attention", "Signed up recently", the two activity tiles
 * and the open ops-alert chip, which can change from outside the operator's own actions (a
 * signup, an ops sweep, time passing). Polls `/api/admin/overview/live`; see
 * `use-live-poll.ts` and `presence.tsx` for why polling and not `router.refresh()`/SSE.
 *
 * MRR and the waitlist count are deliberately NOT live: they change on a webhook or a
 * join, and a first-paint read is enough for a triage screen.
 */

const POLL_INTERVAL_MS = 60 * 1000;

export type { OverviewLiveData };

const OverviewLiveContext = createContext<OverviewLiveData | null>(null);

export function OverviewLiveProvider({
  initial,
  children,
}: {
  initial: OverviewLiveData;
  children: React.ReactNode;
}) {
  const data = useLivePoll<OverviewLiveData>(
    "/api/admin/overview/live",
    initial,
    POLL_INTERVAL_MS
  );
  return (
    <OverviewLiveContext.Provider value={data}>
      {children}
    </OverviewLiveContext.Provider>
  );
}

function useOverviewLive(): OverviewLiveData {
  const value = useContext(OverviewLiveContext);
  if (!value) throw new Error("useOverviewLive used outside OverviewLiveProvider");
  return value;
}

export function LiveAlertsPanel({ totalUsers }: { totalUsers: number }) {
  const { alerts, opsAlerts } = useOverviewLive();
  return (
    <AdminPanel
      title="Needs attention"
      action={
        opsAlerts && opsAlerts.open > 0 ? (
          <Link
            href="/admin/health"
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition-colors duration-fast hover:bg-muted/60",
              opsAlerts.critical > 0
                ? "border-destructive/40 text-destructive"
                : "border-warning/40 text-amber-800 dark:text-warning"
            )}
          >
            {opsAlerts.open} open ops alert{opsAlerts.open === 1 ? "" : "s"} → Ops
          </Link>
        ) : undefined
      }
    >
      {alerts.length === 0 ? (
        <EmptyState>
          Nothing needs you. {totalUsers} account
          {totalUsers === 1 ? "" : "s"}, all healthy.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border/50">
          {alerts.map((alert, i) => (
            <li key={`${alert.userId}-${i}`}>
              <Link
                href={`/admin/users/${encodeURIComponent(alert.userId)}`}
                className="flex items-center gap-3 py-2 transition-colors duration-fast hover:text-primary"
              >
                {alert.severity === "warn" ? (
                  <AlertTriangle
                    className="size-3.5 shrink-0 text-destructive"
                    aria-hidden
                  />
                ) : (
                  <Sparkles
                    className="size-3.5 shrink-0 text-accent-foreground"
                    aria-hidden
                  />
                )}
                <span className="w-32 shrink-0 truncate sm:w-56">
                  {alert.email ?? alert.userId}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {alert.message}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AdminPanel>
  );
}

function KpiLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="block rounded-xl transition-colors duration-fast hover:[&>div]:border-primary/50"
    >
      {children}
    </Link>
  );
}

/**
 * One row of four linked numbers. Each tile is the door to the section that owns it, not a
 * summary of it — the detail lives there.
 */
export function LiveKpiTiles({
  mrr,
  waiting,
  aiByok,
  aiManaged,
}: {
  mrr: string;
  waiting: number | null;
  /** Formatted 30-day AI spend on users' own keys and on Orbit's; "—" when the read failed. */
  aiByok: string;
  aiManaged: string;
}) {
  const { activeLast7d, signupsLast7d } = useOverviewLive();
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <KpiLink href="/admin/billing">
        <MetricTile label="MRR" value={mrr} hint="recurring, comps excluded" />
      </KpiLink>
      <KpiLink href="/admin/growth/retention">
        <MetricTile label="Active 7d" value={activeLast7d} hint="seen or wrote this week" />
      </KpiLink>
      <KpiLink href="/admin/growth">
        <MetricTile label="New signups 7d" value={signupsLast7d} hint="accounts created" />
      </KpiLink>
      <KpiLink href="/admin/access">
        <MetricTile
          label="Waiting"
          value={waiting ?? "—"}
          tone={waiting == null ? "muted" : "default"}
          hint="on the waitlist"
        />
      </KpiLink>
      <KpiLink href="/admin/billing/costs">
        <MetricTile
          label="AI spend on users' keys (BYOK)"
          value={aiByok}
          tone="muted"
          hint="30 days · their bill, not Orbit's"
        />
      </KpiLink>
      <KpiLink href="/admin/billing/costs">
        <MetricTile label="AI spend on Orbit's keys (managed)" value={aiManaged} hint="30 days · Orbit pays" />
      </KpiLink>
    </div>
  );
}

export function LiveRecentSignupsPanel({ totalUsers }: { totalUsers: number }) {
  const { recent } = useOverviewLive();
  return (
    <AdminPanel
      title="Signed up recently"
      action={
        <Link
          href="/admin/users"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          All {totalUsers} →
        </Link>
      }
    >
      {recent.length === 0 ? (
        <EmptyState>No accounts yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-border/50">
          {recent.map((row) => (
            <li key={row.userId}>
              <Link
                href={`/admin/users/${encodeURIComponent(row.userId)}`}
                className="flex items-center gap-3 py-2 transition-colors duration-fast hover:text-primary"
              >
                <span className="min-w-0 flex-1 truncate">
                  {row.email ?? row.userId}
                </span>
                {/* Fixed-width columns, so age, plan, counts and the alert line up down
                    the list instead of each row sizing them to its own content. */}
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  <RelativeTime date={row.signupAt} />
                </span>
                {/* Fixed widths from `sm` up; on a phone the columns size to their content
                    (and the email truncates), or the row ran ~100px past the screen. */}
                <span className="flex shrink-0 justify-start sm:w-40">
                  <PlanBadge plan={row.plan} source={row.planSource} />
                </span>
                <span
                  className={cn(
                    "shrink-0 text-right text-xs tabular-nums sm:w-20",
                    row.counts.contacts === 0 && "text-muted-foreground"
                  )}
                >
                  {row.counts.contacts} · {row.counts.interactions}
                </span>
                {/* The slot is reserved in every row, so rows without the alert keep the
                    counts column in place. */}
                <span className="flex size-3.5 shrink-0">
                  {!row.hasProviderKey && (
                    <CircleAlert
                      className="size-3.5 text-destructive"
                      aria-label="No AI key configured"
                    />
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AdminPanel>
  );
}
