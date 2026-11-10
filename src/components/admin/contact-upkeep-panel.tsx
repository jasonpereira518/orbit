"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Clock,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  UserCheck,
  Users,
} from "lucide-react";
import { AdminPanel, MetricTile } from "@/components/admin/primitives";
import { useLivePoll } from "@/components/admin/use-live-poll";
import { triggerGlobalContactUpkeepAction } from "@/actions/admin";
import type { GlobalUpkeepMetrics } from "@/lib/admin-contact-upkeep";
import { cn } from "@/lib/utils";

export function ContactUpkeepPanel({
  initialMetrics,
}: {
  initialMetrics: GlobalUpkeepMetrics;
}) {
  const metrics = useLivePoll<GlobalUpkeepMetrics>(
    "/api/admin/upkeep/live",
    initialMetrics,
    3000
  );
  const [isPending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<{
    checked: number;
    namesFixed: number;
    avatarsUpdated: number;
    rateLimitsEncountered: number;
    more: boolean;
  } | null>(null);

  const isRunning = isPending || metrics.activeRun !== null;

  const handleRunUpkeep = () => {
    startTransition(async () => {
      try {
        const res = await triggerGlobalContactUpkeepAction({
          batchSize: 100,
          pacingDelayMs: 200,
        });
        if (res.ok) {
          setLastResult(res.stats);
          toast.success(
            `Upkeep pass finished: ${res.stats.checked} checked, ${res.stats.namesFixed} names fixed, ${res.stats.avatarsUpdated} photos updated${res.stats.rateLimitsEncountered > 0 ? ` (${res.stats.rateLimitsEncountered} rate limits backed off)` : ""}`
          );
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to run contact upkeep"
        );
      }
    });
  };

  return (
    <AdminPanel
      title="Global Contact Upkeep & Paced Queue"
      action={
        <div className="flex items-center gap-2">
          {metrics.rateLimited ? (
            <div className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-500 border border-amber-500/20">
              <AlertTriangle className="size-3.5" />
              <span>
                LinkedIn Cooldown ({metrics.cooldownRemainingSeconds}s)
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
              </span>
              <span>Paced & Ready</span>
            </div>
          )}
          <button
            type="button"
            onClick={handleRunUpkeep}
            disabled={isRunning}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50",
              isRunning && "cursor-not-allowed opacity-60"
            )}
          >
            {isRunning ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                <span>Running Upkeep…</span>
              </>
            ) : (
              <>
                <Play className="size-3.5 fill-current" />
                <span>Run Network Upkeep</span>
              </>
            )}
          </button>
        </div>
      }
      className="mb-6"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Audits and repairs contacts across all user accounts without third-party API costs. Resolves handles, usernames, and generic placeholders into real names, and backfills profile photos using LinkedIn direct scraping, Gravatar, and connected address books. Requests are paced at 200ms with automatic backoff to prevent rate limits.
        </p>

        {metrics.activeRun && (
          <div className="flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-primary">
            <div className="flex items-center gap-2">
              <RefreshCw className="size-4 animate-spin text-primary" />
              <span>
                Active job in progress (started{" "}
                {new Date(metrics.activeRun.startedAt).toLocaleTimeString()}
                ): {metrics.activeRun.stats.checked ?? 0} evaluated so far…
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricTile
            label="Total Candidates"
            value={metrics.totalCandidates}
            hint="Contacts needing name or avatar upkeep"
            icon={Users}
            tone={metrics.totalCandidates > 0 ? "accent" : "default"}
          />
          <MetricTile
            label="Names to Verify"
            value={metrics.namesToFix}
            hint="Handles, usernames, or placeholder names"
            icon={UserCheck}
            tone={metrics.namesToFix > 0 ? "accent" : "muted"}
          />
          <MetricTile
            label="Avatars Needed"
            value={metrics.avatarsNeeded}
            hint="Missing, placeholder, or broken photos"
            icon={Sparkles}
            tone={metrics.avatarsNeeded > 0 ? "accent" : "muted"}
          />
        </div>

        {(lastResult || metrics.lastRun) && (
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="size-3.5 text-muted-foreground" />
              <span>
                Last completed upkeep:{" "}
                <span className="font-medium text-foreground">
                  {lastResult?.checked ?? metrics.lastRun?.stats.checked ?? 0}{" "}
                  contacts checked
                </span>
                ,{" "}
                <span className="font-medium text-foreground">
                  {lastResult?.namesFixed ??
                    metrics.lastRun?.stats.namesFixed ??
                    0}{" "}
                  names fixed
                </span>
                ,{" "}
                <span className="font-medium text-foreground">
                  {lastResult?.avatarsUpdated ??
                    metrics.lastRun?.stats.avatarsUpdated ??
                    0}{" "}
                  photos added
                </span>
                .
              </span>
            </div>
            {((lastResult?.rateLimitsEncountered ??
              Number(metrics.lastRun?.stats.rateLimitsEncountered || 0)) > 0) && (
              <span className="text-amber-500">
                Paced backoff triggered{" "}
                {lastResult?.rateLimitsEncountered ??
                  metrics.lastRun?.stats.rateLimitsEncountered}{" "}
                times
              </span>
            )}
          </div>
        )}
      </div>
    </AdminPanel>
  );
}
