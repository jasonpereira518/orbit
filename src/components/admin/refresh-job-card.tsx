"use client";

import { useId, useState } from "react";
import { Play, User } from "lucide-react";
import { runRefreshJobAction } from "@/actions/admin";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { RelativeTime } from "@/components/admin/relative-time";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

const STATE_DOT: Record<string, string> = {
  ok: "bg-emerald-500",
  running: "bg-sky-500",
  partial: "bg-amber-500",
  stale: "bg-amber-500",
  failed: "bg-destructive",
};

type LastRun = {
  state: string;
  startedAt: string;
  durationMs: number | null;
  stats: Record<string, number | boolean>;
  error: string | null;
};

/** One job on Ops › Refresh: its last scheduled or manual run, and the two ways to run it. */
export function RefreshJobCard({
  jobKey,
  label,
  description,
  canRunAll,
  canRunOne,
  lastRun,
  hasLedger,
}: {
  jobKey: string;
  label: string;
  description: string;
  canRunAll: boolean;
  canRunOne: boolean;
  lastRun: LastRun | null;
  hasLedger: boolean;
}) {
  const [target, setTarget] = useState("");
  const inputId = useId();
  const stats = lastRun
    ? Object.entries(lastRun.stats)
        .filter(([, v]) => typeof v === "number")
        .slice(0, 4)
    : [];

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-medium">{label}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>

      <div className="text-xs text-muted-foreground">
        {!hasLedger ? (
          "Runs per account only; no scheduled ledger."
        ) : !lastRun ? (
          "Never run."
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", STATE_DOT[lastRun.state] ?? "bg-muted-foreground/40")}
              />
              <span className="capitalize">{lastRun.state}</span>
              <span aria-hidden>·</span>
              <RelativeTime date={lastRun.startedAt} />
            </div>
            {stats.length > 0 && (
              <div className="tabular-nums">{stats.map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
            )}
            {lastRun.error && <div className="text-destructive">{lastRun.error}</div>}
          </div>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {canRunAll && (
          <ConfirmActionDialog
            trigger={
              <button type="button" className={BUTTON}>
                <Play className="size-3" aria-hidden />
                Run for all
              </button>
            }
            title={`Run ${label} for every account?`}
            description="Runs the scheduled job now, in the background. Reload later to see the run on this card."
            confirmLabel={`Run ${label}`}
            onConfirm={(reason) => runRefreshJobAction({ key: jobKey, scope: "all", reason })}
          />
        )}
        {canRunOne && (
          <div className="flex w-full min-w-0 items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              User id or email for {label}
            </label>
            <Input
              id={inputId}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="User id or email"
              className="h-7 min-w-0 flex-1 text-xs"
            />
            <ConfirmActionDialog
              trigger={
                <button type="button" className={BUTTON} disabled={!target.trim()}>
                  <User className="size-3" aria-hidden />
                  Run for user
                </button>
              }
              title={`Run ${label} for ${target.trim()}?`}
              description="Starts this job for one account. It works through that account's backlog in the background."
              confirmLabel={`Run ${label}`}
              onConfirm={(reason) =>
                runRefreshJobAction({ key: jobKey, scope: "user", target, reason })
              }
            />
          </div>
        )}
      </div>
    </section>
  );
}
