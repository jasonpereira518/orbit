"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { AlertTriangle, CircleAlert, Sparkles } from "lucide-react";
import {
  AdminPanel,
  EmptyState,
  MiniBars,
  PlanBadge,
  RelativeTime,
} from "@/components/admin/primitives";
import { useLivePoll } from "@/components/admin/use-live-poll";
import type { AdminAlert, FunnelStage, WindowCount } from "@/lib/admin-metrics";
import type { Plan, PlanSource } from "@/lib/plan-limits";
import { cn } from "@/lib/utils";

/**
 * Live data for `/admin` — the "Needs attention", "Activation" and "Signed up recently"
 * panels, which can change from outside the operator's own actions (a signup, an ops
 * sweep, time passing). Polls `/api/admin/overview/live`; see `use-live-poll.ts` and
 * `presence.tsx` for why polling and not `router.refresh()`/SSE.
 *
 * The header subtitle and the Money panel are deliberately NOT live — they're either
 * cheap first-paint context or numbers that only ever change from an admin's own edit
 * elsewhere in the console, which already gets a full page refresh on save.
 */

const POLL_INTERVAL_MS = 30 * 1000;

export type OverviewLiveRow = {
  userId: string;
  email: string | null;
  signupAt: string;
  plan: Plan;
  planSource: PlanSource;
  counts: { contacts: number; interactions: number };
  hasProviderKey: boolean;
};

export type OverviewLiveData = {
  alerts: AdminAlert[];
  funnel: FunnelStage[];
  recent: OverviewLiveRow[];
  signups: WindowCount;
  activeLast7d: number;
};

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
  const { alerts } = useOverviewLive();
  return (
    <AdminPanel title="Needs attention">
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
                <span className="w-56 shrink-0 truncate">
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

export function LiveActivationPanel() {
  const { funnel, signups, activeLast7d } = useOverviewLive();
  return (
    <AdminPanel title="Activation">
      <MiniBars rows={funnel.map((s) => ({ label: s.label, count: s.count }))} />
      <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground tabular-nums">
        {signups.current} new in the last 30 days ({signups.previous} in the 30
        before) · {activeLast7d} active this week
      </p>
    </AdminPanel>
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
                <span className="shrink-0 text-xs text-muted-foreground">
                  <RelativeTime date={row.signupAt} />
                </span>
                <PlanBadge plan={row.plan} source={row.planSource} />
                <span
                  className={cn(
                    "w-20 shrink-0 text-right text-xs tabular-nums",
                    row.counts.contacts === 0 && "text-muted-foreground"
                  )}
                >
                  {row.counts.contacts} · {row.counts.interactions}
                </span>
                {!row.hasProviderKey && (
                  <CircleAlert
                    className="size-3.5 shrink-0 text-destructive"
                    aria-label="No AI key configured"
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AdminPanel>
  );
}
