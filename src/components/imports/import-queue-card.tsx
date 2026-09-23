"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, ChevronDown, CircleSlash, FileWarning, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ImportFinishCard } from "@/components/imports/import-finish-card";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import { ImportProgress } from "@/components/imports/import-utils";
import { useImportJob } from "@/lib/import-job-runner";
import { getFinishedImportsFor } from "@/actions/imports";
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
  finishedImportIds,
  unfinishedLine,
  unfinishedSteps,
  type QueuedImport,
} from "@/lib/imports/import-queue";
import { finishCopy, mergeFinishSummaries } from "@/lib/imports/import-finish";
import { MAX_FACES } from "@/lib/imports/finish-scene-geometry";
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
  onFinishUndone,
}: {
  /**
   * Told which import the person just dismissed. The hub renders the same finish from the
   * server once the queue is cleared, so without this the X would put the card straight
   * back on screen.
   */
  onFinishDismiss?: (importIds: string[]) => void;
  /**
   * Opens that import's history sheet — the finish with nobody new to link to says "See what
   * changed" instead, and the sheet lives in the hub, not here.
   */
  onShowFinishDetail?: (importId: string) => void;
  /** Called after the done card's Undo has run, so the page can re-read the history. */
  onFinishUndone?: () => void;
} = {}) {
  const queue = useImportQueue();
  const job = useImportJob();
  const [open, setOpen] = useState<string | null>(null);
  const [running, start] = useTransition();
  const [parts, setParts] = useState<LatestFinishedImport[] | null>(null);
  // One ask per run: the effect's other dependencies change while a queue is being cleared,
  // and re-asking each time would flash a new scene over a settled one.
  const asked = useRef(false);

  /** The ids this run actually wrote — the whole basis for the card below. */
  const runImportIds = finishedImportIds(queue.items);
  const runKey = runImportIds.join(",");

  /**
   * The finish's numbers come from the server, for the imports THIS run produced.
   *
   * The queue knows which files ran and which of them didn't finish; it does not know how
   * many people each one actually brought in — the runner's snapshot carries a progress bar
   * and a completion line, not counters. So the ids go to the server and the counts come
   * back, which is also what makes the card's sentence and the history chips below it agree
   * by construction rather than by two implementations of the same arithmetic.
   *
   * It used to ask for "the newest completed import on the account" instead, which is a
   * different claim and was wrong in two reachable ways: a drop of files nothing recognises
   * reaches `phase: "done"` with no steps at all, and a run whose every step broke reaches it
   * with no finished ones — both then celebrated somebody else's import and offered a button
   * into its people. An empty id list now means no card, and the "nothing recognised" line
   * underneath becomes reachable again.
   */
  useEffect(() => {
    if (queue.phase !== "done" || !runKey || asked.current) return;
    asked.current = true;
    let alive = true;
    void (async () => {
      try {
        const found = await getFinishedImportsFor(runKey.split(","));
        if (alive && found.length) setParts(found);
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
      setParts(null);
    };
  }, [queue.phase, runKey]);

  if (!queue.items.length && !queue.ignored.length) return null;

  // Every step that broke or that Stop ended — not just the failed ones. A stopped step is
  // `skipped` or (if it was running) `done` with a cancelled import, so a failed-only filter
  // turned "stopped after the first of five files" into a pure celebration of that one file.
  const unfinished = unfinishedSteps(queue.items);
  // One drop is one card: the run's imports summed, in the order the steps ran.
  const summary = parts
    ? mergeFinishSummaries(parts, unfinishedLine(queue.items))
    : null;

  /**
   * The finish, announced.
   *
   * A live region only speaks reliably when its content changes while it is already in the
   * document; one that mounts with its text inside — which is what the done card's own
   * sentence would be — is often read as nothing. So the region is rendered empty from the
   * moment a drop is staged, at the same place in the tree whichever branch below renders,
   * and the sentence is set into it once the run is done and the server has answered with
   * its numbers. It persists across the running → done swap because it is the first child of
   * the same root element in both.
   */
  const finished =
    queue.phase === "done" && summary ? finishCopy(summary) : null;
  const announcer = (
    <div key="finish-announcer" role="status" className="sr-only">
      {finished ? (
        <>
          <p>{finished.headline}</p>
          {finished.detail ? <p>{finished.detail}</p> : null}
        </>
      ) : null}
    </div>
  );

  if (queue.phase === "done" && summary && parts) {
    return (
      <div className="space-y-3">
        {announcer}
        <ImportFinishCard
          summary={summary}
          avatars={parts.flatMap((p) => p.avatars).slice(0, MAX_FACES)}
          onDismiss={() => {
            onFinishDismiss?.(summary.importIds);
            clearImportQueue();
          }}
          onShowDetail={() => onShowFinishDetail?.(summary.importIds[0])}
          onUndone={() => {
            // The card was celebrating the people this just removed, and its summary is
            // client state that no server refresh reaches. Clearing the run retires the
            // card; the history rows below now read "Undone" and tell the whole story.
            clearImportQueue();
            onFinishUndone?.();
          }}
        />
        {/*
          The steps behind the card's lead line, each still visible as its own locked row: what
          broke says why, what Stop ended says so, and the one that was running when it did
          keeps its "rows kept" line. The card leads with one sentence; this is the per-file
          truth under it.
        */}
        {unfinished.length ? (
          <ul className="space-y-2">
            {unfinished.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                people={[]}
                expanded={false}
                onToggle={() => {}}
                locked
              />
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
    <div className="space-y-3">
      {announcer}
      <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">
              {queue.phase === "previewing"
                ? "Reading your files…"
                : queue.phase === "done"
                  ? queue.items.some((i) => i.stopped)
                    ? IMPORT_COPY.stopped
                    : "Import finished"
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
    </div>
  );
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

const STOPPED_BADGE = { label: "Stopped", variant: "outline" } as const;

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
  // Stop outranks the status: a stopped step is `skipped` or `done`, and neither "Skipped"
  // (which is also what a file the person chose not to import says) nor "Imported" is true.
  const badge = item.stopped ? STOPPED_BADGE : STATUS_BADGE[item.status];
  const reviewable = item.status === "needs_review" && people.length > 0;
  // The icon follows the same rule: a step stopped mid-run is `done`, but a tick beside it
  // would say it finished.
  const look = item.stopped ? "skipped" : item.status;

  return (
    <li className="rounded-xl border border-border/60">
      <div className="flex items-center gap-3 p-3">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            look === "done" && "bg-primary/10 text-primary",
            look === "failed" && "bg-destructive/10 text-destructive",
            look === "skipped" && "bg-muted text-muted-foreground",
            !["done", "failed", "skipped"].includes(look) &&
              "bg-muted text-muted-foreground",
          )}
        >
          {look === "done" ? (
            <Check className="size-3.5" />
          ) : look === "failed" ? (
            <FileWarning className="size-3.5" />
          ) : look === "skipped" ? (
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
