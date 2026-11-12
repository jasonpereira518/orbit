"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Gauge, Hourglass, ImageOff, Images, Loader2, Play, Square, Users } from "lucide-react";
import { AdminPanel, MetricTile } from "@/components/admin/primitives";
import { useLivePoll } from "@/components/admin/use-live-poll";
import { startLinkedInPhotoQueueAction, stopLinkedInPhotoQueueAction } from "@/actions/admin";
import type { LinkedInPhotoQueueMetrics } from "@/lib/linkedin-photo-queue";
import { friendlyError } from "@/lib/errors";

function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.round(h / 24)} days`;
}

function clock(ms: number, withDay = false): string {
  return new Date(ms).toLocaleString([], { ...(withDay ? { weekday: "short" as const } : {}), hour: "numeric", minute: "2-digit" });
}

function stateLine(m: LinkedInPhotoQueueMetrics): string {
  switch (m.state) {
    case "idle":
      return "Not started yet.";
    case "running":
      return m.finishAt
        ? `Running. At this rate it finishes around ${clock(m.finishAt, true)}.`
        : "Running: one person every few seconds.";
    case "paused":
      return `Paused: LinkedIn pushed back. Resumes on its own around ${clock(m.run!.resumeAt!)}.`;
    case "waiting":
      return "Between steps. If this lasts more than a few minutes, press Resume.";
    case "done":
      return "Finished: everyone has been looked up.";
    case "stopped":
      return "Stopped.";
    case "failed":
      return `Stopped on an error: ${m.run?.error ?? "unknown"}.`;
  }
}

/**
 * The LinkedIn photo queue (`src/lib/linkedin-photo-queue.ts`): every LinkedIn person across
 * all accounts, most-shared first, paced so LinkedIn does not block us.
 */
export function LinkedInPhotoQueuePanel({ initial }: { initial: LinkedInPhotoQueueMetrics }) {
  const m = useLivePoll<LinkedInPhotoQueueMetrics>("/api/admin/linkedin-queue/live", initial, 5000);
  const [isPending, startTransition] = useTransition();

  const active = m.state === "running" || m.state === "paused" || m.state === "waiting";
  const found = m.run?.found ?? 0;
  const missed = m.run?.missed ?? 0;
  const done = active || m.state === "done" ? found + missed : 0;
  const pct = done + m.pending > 0 ? Math.round((done / (done + m.pending)) * 100) : 0;

  const act = (fn: () => Promise<unknown>, ok: string, fail: string) =>
    startTransition(async () => {
      try {
        await fn();
        toast.success(ok);
      } catch (err) {
        toast.error(friendlyError(err, fail));
      }
    });

  return (
    <AdminPanel
      title="LinkedIn photo queue"
      className="mb-6"
      action={
        <div className="flex items-center gap-2">
          {active && (
            <button
              type="button"
              disabled={isPending}
              onClick={() => act(stopLinkedInPhotoQueueAction, "Queue stopped", "The queue didn’t stop — try again?")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <Square className="size-3.5" aria-hidden />
              Stop
            </button>
          )}
          {m.state !== "running" && (
            <button
              type="button"
              disabled={isPending || (!active && m.pending === 0)}
              onClick={() =>
                act(
                  startLinkedInPhotoQueueAction,
                  active ? "Queue resumed" : "Queue started",
                  "The queue didn’t start — try again?"
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
            >
              {isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5 fill-current" aria-hidden />}
              {active ? "Resume now" : "Start queue"}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Looks up each LinkedIn person once for every account, most-shared first: LinkedIn directly, then
          Unavatar and Microlink while their daily allowance lasts. Paced to about 15 a minute; if LinkedIn
          pushes back it pauses (30 min, doubling up to 6 h) and resumes on its own.
          {!m.blobReady && " Needs photo storage (BLOB_READ_WRITE_TOKEN) before it can start."}
        </p>

        <div role="status" aria-live="polite" className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            {/* Clock times are local: the server renders them in its own timezone first. */}
            <span className="text-foreground" suppressHydrationWarning>{stateLine(m)}</span>
            {(active || m.state === "done") && <span className="tabular-nums text-muted-foreground">{pct}%</span>}
          </div>
          {(active || m.state === "done") && (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <MetricTile label="Left" value={m.pending.toLocaleString()} hint="People still to look up" icon={Users} tone={m.pending > 0 ? "accent" : "muted"} />
          <MetricTile label="Found" value={found.toLocaleString()} hint="Photos added this run" icon={Images} />
          <MetricTile label="No photo" value={missed.toLocaleString()} hint="Rechecked in 30 days" icon={ImageOff} tone="muted" />
          <MetricTile
            label="Rate"
            value={m.perHour ? `${Math.round(m.perHour).toLocaleString()}/h` : "—"}
            hint="People per hour, pauses included"
            icon={Gauge}
          />
          <MetricTile
            label="Time left"
            value={m.etaMs ? formatDuration(m.etaMs) : "—"}
            hint={m.etaMs ? "At the current rate" : "Shown once it has run a minute"}
            icon={Hourglass}
          />
        </div>
      </div>
    </AdminPanel>
  );
}
