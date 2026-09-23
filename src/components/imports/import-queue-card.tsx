"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, ChevronDown, CircleSlash, FileWarning, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ImportFinishCard } from "@/components/imports/import-finish-card";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { ImportProgress } from "@/components/imports/import-utils";
import { useImportJob } from "@/lib/import-job-runner";
import { getLatestFinishedImport } from "@/actions/imports";
import {
  clearImportQueue,
  runQueue,
  setSelection,
  skipItem,
  stopQueue,
  useImportQueue,
} from "@/lib/imports/use-import-queue";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  TARGET_LABEL_INLINE,
  type QueuedImport,
} from "@/lib/imports/import-queue";
import type { ImportTarget } from "@/lib/imports/detect-import-file";
import type { LatestFinishedImport } from "@/actions/imports";

/**
 * Everything one drop staged, reviewed together and then run without further prompting.
 *
 * Stopping at each file's review would make "queue and run in sequence" stop-and-go, which is
 * the opposite of what dropping a folder is for. So every file is previewed up front, the
 * person confirms once, and the rest happens unattended.
 */
export function ImportQueueCard({
  onFinishDismiss,
  onShowFinishDetail,
}: {
  /**
   * Told which import the person just dismissed. The hub renders the same finish from the
   * server once the queue is cleared, so without this the X would put the card straight
   * back on screen.
   */
  onFinishDismiss?: (importId: string) => void;
  /**
   * Opens that import's history sheet — the finish with nobody new to link to says "See what
   * changed" instead, and the sheet lives in the hub, not here.
   */
  onShowFinishDetail?: (importId: string) => void;
} = {}) {
  const queue = useImportQueue();
  const job = useImportJob();
  const [open, setOpen] = useState<string | null>(null);
  const [running, start] = useTransition();
  const [finish, setFinish] = useState<LatestFinishedImport | null>(null);
  // One ask per run: the effect's other dependencies change while a queue is being cleared,
  // and re-asking each time would flash a new scene over a settled one.
  const asked = useRef(false);

  /**
   * The finish's numbers come from the server, not from the queue.
   *
   * The queue knows which files ran and which of them didn't finish; it does not know how
   * many people each one actually brought in — the runner's snapshot carries a progress bar
   * and a completion line, not counters. Asking the server for the import it just wrote is
   * also what makes the card's sentence and the history chips below it agree by construction
   * rather than by two implementations of the same arithmetic.
   */
  useEffect(() => {
    if (queue.phase !== "done" || asked.current) return;
    asked.current = true;
    let alive = true;
    void (async () => {
      try {
        const latest = await getLatestFinishedImport();
        // An import that has already been undone has nothing to celebrate.
        if (alive && latest && !latest.undoneAt) setFinish(latest);
      } catch {
        // The rows below already say what happened, per file. A finish card is the nicer
        // version of that, not the only one.
      }
    })();
    // Cleanup, not the effect body: leaving the done phase is what makes this finish stale,
    // and clearing it here means the next run cannot flash the previous one's card in the
    // moment between its own last step and the server answering.
    return () => {
      alive = false;
      asked.current = false;
      setFinish(null);
    };
  }, [queue.phase]);

  if (!queue.items.length && !queue.ignored.length) return null;

  const unfinishedSteps = queue.items.filter((i) => i.status === "failed");

  if (queue.phase === "done" && finish) {
    return (
      <div className="space-y-3">
        <ImportFinishCard
          summary={{
            ...finish,
            unfinished: unfinishedLine(unfinishedSteps),
          }}
          avatars={finish.avatars}
          onDismiss={() => {
            onFinishDismiss?.(finish.importId);
            clearImportQueue();
          }}
          onShowDetail={() => onShowFinishDetail?.(finish.importId)}
        />
        {unfinishedSteps.length ? (
          <ul className="space-y-1">
            {unfinishedSteps.map((item) => (
              <li key={item.id} className="text-xs text-destructive">
                {item.fileName} — {item.error ?? IMPORT_COPY.importFailed}
              </li>
            ))}
          </ul>
        ) : null}
        {queue.ignored.length ? <IgnoredList ignored={queue.ignored} /> : null}
        {queue.truncated ? (
          <p className="text-xs text-muted-foreground">
            {IMPORT_COPY.truncated}
          </p>
        ) : null}
      </div>
    );
  }

  const reviewable = queue.items.filter(
    (i) => i.status === "needs_review" && (i.ids?.length ?? 0) > 0,
  );
  const emptyPreviews = queue.items.filter(
    (i) => i.status === "needs_review" && !(i.ids?.length ?? 0),
  );
  // Calendar's sentinel id is not a person, so it must not inflate this count.
  const selectedTotal = reviewable.reduce(
    (n, i) => n + (isPeopleImport(i) ? (i.ids?.length ?? 0) : 0),
    0,
  );
  const isRunning = queue.phase === "running";

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">
            {queue.phase === "previewing"
              ? "Reading your files…"
              : queue.phase === "done"
                ? "Import finished"
                : isRunning
                  ? "Importing"
                  : "Ready to import"}
          </h2>
          {queue.truncated ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {IMPORT_COPY.truncated}
            </p>
          ) : null}
        </div>
        {queue.phase === "done" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={clearImportQueue}
          >
            <X className="size-4" />
            <span className="sr-only">Dismiss</span>
          </Button>
        ) : null}
      </div>

      {isRunning && job?.progress ? (
        <ImportProgress
          {...job.progress}
          step={job.step}
          cancelling={job.cancelling}
          onCancel={stopQueue}
        />
      ) : null}

      <ul className="space-y-2">
        {queue.items.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            people={queue.people.get(item.id) ?? []}
            expanded={open === item.id}
            onToggle={() => setOpen(open === item.id ? null : item.id)}
            locked={isRunning || queue.phase === "done"}
          />
        ))}
      </ul>

      {emptyPreviews.length ? (
        <p className="text-xs text-muted-foreground">
          {emptyPreviews.map((i) => i.fileName).join(", ")} — nobody new to
          import from {emptyPreviews.length === 1 ? "this one" : "these"}
        </p>
      ) : null}

      {queue.ignored.length ? <IgnoredList ignored={queue.ignored} /> : null}

      {!queue.items.length && queue.ignored.length ? (
        <p className="text-sm text-muted-foreground">
          {IMPORT_COPY.nothingRecognised}
        </p>
      ) : null}

      {queue.phase === "review" && reviewable.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={running || reviewable.length === 0}
            onClick={() =>
              start(async () => {
                const { message } = await runQueue();
                toast.success(message);
              })
            }
          >
            {reviewable.length === 1
              ? "Import"
              : `Import everything (${reviewable.length} files)`}
          </Button>
          {selectedTotal ? (
            <span className="text-xs text-muted-foreground">
              {selectedTotal} {selectedTotal === 1 ? "person" : "people"} selected
            </span>
          ) : null}
        </div>
      ) : null}

      {isRunning ? (
        <Button
          type="button"
          variant="outline"
          onClick={stopQueue}
          disabled={queue.stopping}
        >
          {queue.stopping ? "Stopping…" : "Stop"}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The one line a done card leads with when a step didn't land.
 *
 * `finishCopy` puts this where the celebration would go, so it has to be the whole story in a
 * sentence — the per-file detail is right underneath it. Named with the inline labels, which
 * keep LinkedIn a proper noun inside a sentence.
 */
function unfinishedLine(steps: QueuedImport[]): string | undefined {
  if (!steps.length) return undefined;
  const labels = steps.map(
    (i) =>
      TARGET_LABEL_INLINE[i.target as Exclude<ImportTarget, "unknown">] ??
      i.label,
  );
  const named =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `Your ${named} didn’t finish`;
}

/** Files the drop could not use, grouped by reason. */
function IgnoredList({
  ignored,
}: {
  ignored: { name: string; reason: string }[];
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
      <p className="text-xs font-medium text-muted-foreground">
        {IMPORT_COPY.notImported}
      </p>
      <ul className="mt-1.5 space-y-1">
        {groupIgnored(ignored).map((group) => (
          <li
            key={group.reason}
            className="truncate text-xs text-muted-foreground"
          >
            {group.names.length > 3
              ? `${group.names.length} files — ${group.reason}`
              : `${group.names.join(", ")} — ${group.reason}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Collapse the "Not imported" list by reason.
 *
 * A LinkedIn export folder contributes about 28 files that all skip for the same reason, and
 * naming each one is noise standing where one sentence would do. Grouping also makes the
 * reason the subject, which is what a person actually needs to read.
 */
function groupIgnored(
  ignored: { name: string; reason: string }[],
): { reason: string; names: string[] }[] {
  const byReason = new Map<string, string[]>();
  for (const f of ignored) {
    const names = byReason.get(f.reason);
    if (names) names.push(f.name);
    else byReason.set(f.reason, [f.name]);
  }
  return [...byReason].map(([reason, names]) => ({ reason, names }));
}

/**
 * Whether this step imports people you pick one by one.
 *
 * Calendar does not: a whole file is confirmed at once, and its `ids` holds a single sentinel
 * that makes the reducer treat it as runnable. Counting that sentinel as a selected person is
 * what produced "1 of 0 selected", and it inflated the total under the button.
 */
function isPeopleImport(item: QueuedImport): boolean {
  return item.target !== "calendar_ics" && item.target !== "calendar_csv";
}

const STATUS_BADGE: Record<
  QueuedImport["status"],
  {
    label: string;
    variant: "default" | "secondary" | "outline" | "destructive";
  } | null
> = {
  waiting: { label: "Waiting", variant: "outline" },
  previewing: { label: "Reading…", variant: "outline" },
  needs_review: null,
  running: { label: "Importing", variant: "secondary" },
  done: { label: "Imported", variant: "secondary" },
  failed: { label: "Didn’t finish", variant: "destructive" },
  skipped: { label: "Skipped", variant: "outline" },
};

function QueueRow({
  item,
  people,
  expanded,
  onToggle,
  locked,
}: {
  item: QueuedImport;
  people: ReturnType<typeof useImportQueue>["people"] extends Map<
    string,
    infer P
  >
    ? P
    : never;
  expanded: boolean;
  onToggle: () => void;
  locked: boolean;
}) {
  const badge = STATUS_BADGE[item.status];
  const reviewable = item.status === "needs_review" && people.length > 0;

  return (
    <li className="rounded-xl border border-border/60">
      <div className="flex items-center gap-3 p-3">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            item.status === "done" && "bg-primary/10 text-primary",
            item.status === "failed" && "bg-destructive/10 text-destructive",
            item.status === "skipped" && "bg-muted text-muted-foreground",
            !["done", "failed", "skipped"].includes(item.status) &&
              "bg-muted text-muted-foreground",
          )}
        >
          {item.status === "done" ? (
            <Check className="size-3.5" />
          ) : item.status === "failed" ? (
            <FileWarning className="size-3.5" />
          ) : item.status === "skipped" ? (
            <CircleSlash className="size-3.5" />
          ) : (
            <span className="text-[0.65rem] font-medium">
              {item.label.slice(0, 1)}
            </span>
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {item.error
              ? item.error
              : item.result
                ? item.result
                : item.status === "needs_review"
                  ? isPeopleImport(item)
                    ? `${item.fileName} — ${item.ids?.length ?? 0} of ${item.reviewCount ?? 0} selected`
                    : `${item.fileName} — meetings with people you already know`
                  : item.fileName}
          </p>
        </div>

        {badge ? (
          <Badge variant={badge.variant} className="shrink-0">
            {badge.label}
          </Badge>
        ) : null}

        {reviewable && !locked ? (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={onToggle}>
              Review
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => skipItem(item.id)}
            >
              <X className="size-4" />
              <span className="sr-only">Don’t import {item.label}</span>
            </Button>
          </>
        ) : null}
      </div>

      {expanded && reviewable ? (
        <div className="border-t border-border/60 p-3">
          <ImportPeopleReview
            people={people}
            selectedIds={new Set(item.ids ?? [])}
            onSelectedIdsChange={(next) => setSelection(item.id, [...next])}
            onRemove={(id) =>
              setSelection(
                item.id,
                (item.ids ?? []).filter((x) => x !== id),
              )
            }
          />
        </div>
      ) : null}
    </li>
  );
}
