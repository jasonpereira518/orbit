"use client";

import { Fragment, useEffect, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Check, ChevronRight, CircleAlert, History, Loader2, Trash2 } from "lucide-react";
import { listCaptureHistory } from "@/actions/capture";
import { deleteNoteBatch } from "@/actions/note-batches";
import { discardCaptureBatch, discardCaptureJob } from "@/actions/capture-jobs";
import type { CaptureHistoryItem, CaptureHistoryPage, CaptureHistoryPending, PendingStatus } from "@/lib/capture-history";
import { timelineDayLabel } from "@/lib/timeline-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAPTURE_METHOD_META } from "@/components/capture/capture-source-meta";
import { NOTE_SOURCE_LABEL, NoteSourceMark, type NoteSource } from "@/components/capture/note-source-mark";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/ui/brand-logo";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { useConfirmFocus } from "@/components/settings/use-confirm-focus";

/** False during SSR and the hydrating render, true afterwards. */
function useHydrated() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** How often the queue is re-read while something in it is still being read or saved. */
const POLL_MS = 2500;

/**
 * Captures from a re-read first page that were saved after everything already shown. Only
 * newer ones: the re-read page can be longer than what is on screen, and its older rows
 * belong to "See more", not the top of the list.
 */
function newerThan(shown: CaptureHistoryItem[], page: CaptureHistoryItem[]): CaptureHistoryItem[] {
  const seen = new Set(shown.map((i) => i.id));
  const top = shown[0]?.createdAt ?? "";
  return page.filter((i) => !seen.has(i.id) && i.createdAt > top);
}

const isBusy = (status: PendingStatus) => status === "extracting" || status === "saving";
const pendingBusy = (p: CaptureHistoryPending) => (p.kind === "drop" ? p.files.some((f) => isBusy(f.status)) : isBusy(p.status));

/**
 * The capture queue and history in one list: what still needs you on top (notes being read,
 * reviews waiting, files that failed — a multi-file drop as one card), then every capture
 * you have saved, newest first, with a "See more" that pages further back.
 *
 * The first page arrives rendered from the server; later pages come from
 * `listCaptureHistory` with the cursor the previous page handed back. Pages are merged by
 * id, so a capture saved in another tab between two clicks can never appear twice.
 *
 * While anything waiting is still being read or saved, the first page is re-read every few
 * seconds: the queue's rows move on, and a capture that finished saving joins the list.
 *
 * Each row can be deleted behind an in-place confirm. Deleting only drops the row
 * locally: the cursor is a keyset position, not an offset, so the next page is unmoved.
 */
export function CaptureHistoryList({ initial }: { initial: CaptureHistoryPage }) {
  const [items, setItems] = useState(initial.items);
  const [queue, setQueue] = useState(initial.pending);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();
  const focus = useConfirmFocus(confirming);
  const busy = queue.some(pendingBusy);

  // A server refresh (an upload just queued, a save revalidated the page) hands down a new
  // first page: take its queue and any captures this list has not seen.
  const [fromServer, setFromServer] = useState(initial);
  const [settled, setSettled] = useState(false);
  if (initial !== fromServer) {
    setFromServer(initial);
    setQueue(initial.pending);
    setSettled(false);
    const fresh = newerThan(items, initial.items);
    if (fresh.length) setItems([...fresh, ...items]);
  }

  // Re-read the first page while the queue is moving. One extra read shortly after mount
  // too: the page may fold the newest drop into its review just after it renders.
  useEffect(() => {
    if (settled && !busy) return;
    let alive = true;
    const t = setTimeout(() => {
      // The first page (type-only import above: the lib reaches the database).
      void listCaptureHistory(null)
        .then((page) => {
          if (!alive) return;
          setQueue(page.pending);
          setItems((prev) => {
            const fresh = newerThan(prev, page.items);
            return fresh.length ? [...fresh, ...prev] : prev;
          });
          setSettled(true);
        })
        .catch(() => setSettled(true));
    }, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [busy, settled, queue]);

  function onDelete(id: string) {
    startDelete(async () => {
      try {
        await deleteNoteBatch(id);
        setItems((prev) => prev.filter((i) => i.id !== id));
        setConfirming(null);
        toast.success("Capture deleted");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t delete that capture — try again?"));
      }
    });
  }

  async function onDiscardDrop(drop: Extract<CaptureHistoryPending, { kind: "drop" }>) {
    const id = drop.id;
    const res = drop.jobId ? await discardCaptureJob(drop.jobId) : await discardCaptureBatch(id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setQueue((prev) => prev.filter((p) => !(p.kind === "drop" && p.id === id)));
    toast.success("Discarded");
  }

  function loadMore() {
    if (!cursor) return;
    start(async () => {
      try {
        const page = await listCaptureHistory(cursor);
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
        });
        setCursor(page.nextCursor);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t load older captures — try again?"));
      }
    });
  }

  return (
    <section aria-labelledby="capture-history-heading" className="space-y-3">
      <div className="flex items-center gap-2">
        <History className="size-4 text-muted-foreground" aria-hidden />
        <h2 id="capture-history-heading" className="text-base font-medium text-ink">
          Recent captures
        </h2>
      </div>

      {queue.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Needs you</h3>
          <ul className="space-y-2">
            {queue.map((p) =>
              p.kind === "drop" ? (
                <PendingDropCard key={p.id} drop={p} onDiscard={() => onDiscardDrop(p)} />
              ) : (
                <PendingCaptureRow key={p.id} item={p} />
              )
            )}
          </ul>
          {items.length > 0 && <h3 className="pt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Saved</h3>}
        </div>
      )}

      {items.length === 0 && queue.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/70 px-4 py-5 text-sm text-muted-foreground">
          Nothing captured yet. Every capture you save lands here, with the notes and
          photos it came from, so you can always go back to the original.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <CaptureHistoryRow
              key={item.id}
              item={item}
              confirming={confirming === item.id}
              deleting={deleting && confirming === item.id}
              onAskDelete={() => setConfirming(item.id)}
              onCancelDelete={() => setConfirming(null)}
              onDelete={() => onDelete(item.id)}
              triggerRef={focus.triggerRef(item.id)}
              confirmRef={focus.confirmRef(item.id)}
            />
          ))}
        </ul>
      )}

      {cursor && (
        <Button variant="outline" size="sm" disabled={pending} onClick={loadMore}>
          {pending ? "Loading…" : "See more"}
        </Button>
      )}
    </section>
  );
}

const PENDING_BADGE: Record<PendingStatus, string> = {
  extracting: "Reading…",
  ready: "Ready to review",
  saving: "Saving…",
  failed: "Couldn’t read it",
};

/** The source tile every queue and history row starts with. */
function SourceTile({ source }: { source: NoteSource }) {
  return (
    <span
      title={NOTE_SOURCE_LABEL[source]}
      className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground"
    >
      <NoteSourceMark source={source} />
    </span>
  );
}

function CreatedAt({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  const created = new Date(iso);
  return (
    <>
      <time dateTime={iso} title={format(created, "PPpp")}>
        {format(created, "EEE, MMM d, h:mm a")} · {timelineDayLabel(created)}
      </time>
      <span aria-hidden>·</span>
    </>
  );
}

/** One extraction not saved yet (a drive doc, a Granola or Notion pick…): opens its review. */
function PendingCaptureRow({ item }: { item: Extract<CaptureHistoryPending, { kind: "job" }> }) {
  const meta = CAPTURE_METHOD_META[item.method];
  return (
    <li className="rounded-xl border border-dashed border-primary/40 bg-card transition-colors has-[a:hover]:border-primary/60 has-[a:focus-visible]:border-ring">
      <Link
        href={item.href}
        className="group flex min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <SourceTile source={meta.source} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="line-clamp-2 font-medium text-ink">{item.title ?? meta.label}</span>
            <Badge variant={item.status === "failed" ? "destructive" : "secondary"} className="shrink-0 text-3xs">
              {PENDING_BADGE[item.status]}
            </Badge>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <CreatedAt iso={item.createdAt} />
            <span>{meta.label}</span>
            {item.status === "ready" && item.peopleCount > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>{plural(item.peopleCount, "person", "people")} found</span>
              </>
            )}
            {item.error && (
              <>
                <span aria-hidden>·</span>
                <span className="text-destructive">{item.error}</span>
              </>
            )}
          </span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
    </li>
  );
}

function FileStatusIcon({ status }: { status: PendingStatus }) {
  if (status === "failed") return <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />;
  if (isBusy(status)) return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />;
  return <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
}

/**
 * Several files read together (a multi-file upload, a drive-scan pass, a set of picks): one
 * card, because the drop is reviewed as one deck — and saved as one capture per file. The
 * header opens the review; a failed file opens on its own, to retry it.
 */
function PendingDropCard({
  drop,
  onDiscard,
}: {
  drop: Extract<CaptureHistoryPending, { kind: "drop" }>;
  onDiscard: () => Promise<void>;
}) {
  const [discarding, startDiscard] = useTransition();
  const meta = CAPTURE_METHOD_META[drop.method];
  const read = drop.files.filter((f) => f.status === "ready").length;
  const reading = drop.files.filter((f) => isBusy(f.status)).length;
  const failed = drop.files.filter((f) => f.status === "failed").length;
  const people = drop.files.reduce((n, f) => n + (f.status === "ready" ? f.peopleCount : 0), 0);
  const badge = reading ? PENDING_BADGE.extracting : read ? PENDING_BADGE.ready : PENDING_BADGE.failed;
  const progress = [
    read ? `${read} read` : null,
    reading ? `${reading} reading` : null,
    failed ? `${failed} failed` : null,
  ].filter(Boolean);
  const count = plural(drop.files.length, "note", "notes");

  return (
    <li className="rounded-xl border border-dashed border-primary/40 bg-card">
      <div className="flex items-center">
        <Link
          href={drop.href}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <SourceTile source={meta.source} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="font-medium text-ink">{count}</span>
              <Badge variant={!read && !reading ? "destructive" : "secondary"} className="shrink-0 text-3xs">
                {badge}
              </Badge>
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <CreatedAt iso={drop.createdAt} />
              <span>{meta.label}</span>
              <span aria-hidden>·</span>
              <span>{progress.join(" · ")}</span>
              {people > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>{plural(people, "person", "people")} found</span>
                </>
              )}
            </span>
          </span>
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>
        <Button
          size="sm"
          variant="ghost"
          className="mr-2 shrink-0 text-muted-foreground"
          disabled={discarding}
          onClick={() => startDiscard(onDiscard)}
          aria-label={`Discard these ${count}`}
        >
          {discarding ? "Discarding…" : "Discard"}
        </Button>
      </div>
      <ul className="space-y-1 border-t border-border/60 px-3 py-2" aria-label={`Files in this ${count}`}>
        {drop.files.map((f) => {
          const label = (
            <>
              <FileStatusIcon status={f.status} />
              <span className="min-w-0 flex-1 truncate">{f.title ?? "Untitled note"}</span>
              <span className={cn("shrink-0", f.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {f.status === "failed"
                  ? f.error ?? "Couldn’t read it"
                  : f.status === "ready"
                    ? plural(f.peopleCount, "person", "people")
                    : PENDING_BADGE[f.status]}
              </span>
            </>
          );
          return (
            <li key={f.id} className="text-xs text-ink/80">
              {f.status === "failed" ? (
                <Link href={f.href} className="flex items-center gap-2 rounded-md py-0.5 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  {label}
                </Link>
              ) : (
                <span className="flex items-center gap-2 py-0.5">{label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function CaptureHistoryRow({
  item,
  confirming,
  deleting,
  onAskDelete,
  onCancelDelete,
  onDelete,
  triggerRef,
  confirmRef,
}: {
  item: CaptureHistoryItem;
  confirming: boolean;
  deleting: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  triggerRef: (el: HTMLElement | null) => void;
  confirmRef: (el: HTMLElement | null) => void;
}) {
  const hydrated = useHydrated();
  const primary = CAPTURE_METHOD_META[item.method];
  const created = new Date(item.createdAt);
  const counts = [
    plural(item.peopleCount, "person", "people"),
    plural(item.reminderCount, "reminder", "reminders"),
    item.photoCount ? plural(item.photoCount, "photo", "photos") : null,
  ].filter(Boolean);
  const description = item.summary ?? item.excerpt;

  return (
    <li className="rounded-xl border border-border/60 bg-card transition-colors has-[a:hover]:border-primary/40 has-[a:focus-visible]:border-ring">
      {/* The delete button sits beside the link, not inside it: a button nested in an
          anchor is invalid and unreachable by keyboard. */}
      <div className="flex items-center">
        <Link
          href={`/capture/${item.id}`}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {/* Where the notes were taken; the footer names it. */}
          <span
            title={NOTE_SOURCE_LABEL[primary.source]}
            className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground"
          >
            <NoteSourceMark source={primary.source} />
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="line-clamp-2 font-medium text-ink">
                {item.title ?? primary.label}
              </span>
              {item.status === "undone" && (
                <Badge variant="secondary" className="shrink-0 text-3xs">
                  Undone
                </Badge>
              )}
            </span>
            {item.people.length > 0 && (
              <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-xs text-ink/80">
                {item.people.map((p, i) => (
                  <span key={p.name} className="inline-flex min-w-0 items-center gap-1">
                    <span className="truncate">{p.name}</span>
                    {p.org && <BrandLogo key={p.org.domain} domain={p.org.domain} name={p.org.name} className="size-3.5" />}
                    {i < item.people.length - 1 && <span className="-ml-1">,</span>}
                  </span>
                ))}
              </span>
            )}
            {description && (
              <span className="mt-0.5 line-clamp-2 block text-muted-foreground">{description}</span>
            )}
            {item.nextSteps && (
              <span className="mt-0.5 line-clamp-1 block text-muted-foreground">
                <span className="font-medium text-ink/80">Next:</span> {item.nextSteps}
              </span>
            )}
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              {/* Local time only once hydrated: the server renders in its own timezone, and
                  a label that disagrees with the client's is a hydration mismatch. The
                  separator arrives with it, so the line never starts on a stray dot. */}
              {hydrated && (
                <>
                  <time dateTime={item.createdAt} title={format(created, "PPpp")}>
                    {format(created, "EEE, MMM d, h:mm a")} · {timelineDayLabel(created)}
                  </time>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{primary.label}</span>
              {counts.map((c) => (
                <Fragment key={c}>
                  <span aria-hidden>·</span>
                  <span>{c}</span>
                </Fragment>
              ))}
              {item.entryPoint === "profile" && (
                <>
                  <span aria-hidden>·</span>
                  <span>From a profile</span>
                </>
              )}
            </span>
          </span>

          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>
        {!confirming && (
          <Button
            ref={triggerRef}
            size="icon-sm"
            variant="ghost"
            className="mr-2 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Delete capture: ${item.title ?? primary.label}`}
            onClick={onAskDelete}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
          <span role="status" className="mr-auto text-xs text-muted-foreground">
            Delete this capture and its photos? The people and notes it saved stay.
          </span>
          <Button ref={confirmRef} size="sm" variant="destructive" disabled={deleting} onClick={onDelete}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          <Button size="sm" variant="ghost" disabled={deleting} onClick={onCancelDelete}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}
