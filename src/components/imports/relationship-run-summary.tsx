"use client";

import { useEffect, useState, useTransition } from "react";
import { format } from "date-fns";
import { BellPlus, Sparkles, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  dismissRunFlagAction,
  getLatestRelationshipRun,
  remindRunFlag,
  undoRelationshipRunAction,
} from "@/actions/relationships";
import { runSummaryCopy, type RunSummary } from "@/lib/relationship-engine/summary-copy";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { toast } from "@/lib/toast";

const ACTIVE = new Set<RunSummary["status"]>(["queued", "running", "waiting_key"]);

export function RunSummaryView({
  summary,
  busyKey,
  onUndo,
  onRemind,
  onDismiss,
  shared,
}: {
  summary: RunSummary;
  busyKey: string | null;
  onUndo?: () => void;
  onRemind?: (key: string) => void;
  onDismiss?: (key: string) => void;
  shared?: boolean;
}) {
  const copy = runSummaryCopy(summary);
  return (
    <section className="space-y-3" aria-label="Relationship analysis">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{copy.headline}</p>
          {copy.progress ? <p className="text-xs text-muted-foreground">{copy.progress}</p> : null}
          {shared ? <p className="text-xs text-muted-foreground">Analyzed together with an earlier upload</p> : null}
        </div>
        {summary.undoable && onUndo ? (
          <Button size="sm" variant="ghost" onClick={onUndo} disabled={busyKey === "undo"}>
            <Undo2 className="size-3.5" aria-hidden /> Undo all
          </Button>
        ) : null}
      </div>
      {summary.reminders.length ? (
        <ul className="space-y-1 text-sm">
          {summary.reminders.map((r) => (
            <li key={r.id} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {r.title}
                {r.contactName ? <span className="text-muted-foreground"> · {r.contactName}</span> : null}
              </span>
              {r.dueIso ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {format(new Date(`${r.dueIso}T12:00:00`), "MMM d")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.flags.length ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Dates that just passed</p>
          {summary.flags.map((f) => (
            <div key={f.key} className="rounded-md border p-2 text-sm">
              <p>
                {f.title} <span className="text-muted-foreground">· {f.contactName}</span>
              </p>
              <p className="text-xs italic text-muted-foreground">“{f.sourceExcerpt}”</p>
              {onRemind && onDismiss ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busyKey === f.key} onClick={() => onRemind(f.key)}>
                    <BellPlus className="size-3.5" aria-hidden /> Remind me
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busyKey === f.key} onClick={() => onDismiss(f.key)}>
                    <X className="size-3.5" aria-hidden /> Dismiss
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {copy.notes.length || summary.parkedPeople.length ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {copy.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {summary.parkedPeople.length ? (
            <li>Couldn’t read: {summary.parkedPeople.map((p) => p.name).join(", ")}</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

export function RelationshipRunCard({
  initial,
  shared,
  compact,
}: {
  initial: RunSummary | null;
  shared?: boolean;
  compact?: boolean;
}) {
  const [summary, setSummary] = useState(initial);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, start] = useTransition();

  // A new `initial` (the sheet reopened on another import) replaces what the card shows.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setSummary(initial);
  }
  useEffect(() => {
    if (!summary || !ACTIVE.has(summary.status)) return;
    const id = summary.id;
    const t = setInterval(() => {
      getLatestRelationshipRun()
        .then((s) => {
          if (s && s.id === id) setSummary(s);
        })
        .catch(() => {});
    }, 20_000);
    return () => clearInterval(t);
  }, [summary]);

  if (!summary) return null;

  const act = (key: string, run: () => Promise<{ error: string } | object>, ok: string) =>
    start(async () => {
      setBusyKey(key);
      try {
        const res = await run();
        if ("error" in res) {
          toast.error((res as { error: string }).error);
          return;
        }
        toast.success(ok);
        const next = await getLatestRelationshipRun();
        if (next && next.id === summary.id) setSummary(next);
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      } finally {
        setBusyKey(null);
      }
    });

  return (
    <div id={compact ? undefined : "relationship-analysis"} className={compact ? undefined : "rounded-xl border bg-card p-4"}>
      <RunSummaryView
        summary={summary}
        busyKey={busyKey}
        shared={shared}
        onUndo={() => act("undo", () => undoRelationshipRunAction(summary.id), "Analysis undone")}
        onRemind={(key) => act(key, () => remindRunFlag(summary.id, key), "Reminder added")}
        onDismiss={(key) => act(key, () => dismissRunFlagAction(summary.id, key), "Dismissed")}
      />
    </div>
  );
}
