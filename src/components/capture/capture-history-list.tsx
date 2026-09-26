"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronRight, History, Trash2 } from "lucide-react";
import { listCaptureHistory } from "@/actions/capture";
import { deleteNoteBatch } from "@/actions/note-batches";
import type { CaptureHistoryItem, CaptureHistoryPage } from "@/lib/capture-history";
import { timelineDayLabel } from "@/lib/timeline-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAPTURE_SOURCE_META, capturePhotoSrc } from "@/components/capture/capture-source-meta";
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

/**
 * Every capture you have saved, newest first, with a "See more" that pages further back.
 *
 * The first page arrives rendered from the server; later pages come from
 * `listCaptureHistory` with the cursor the previous page handed back. Pages are merged by
 * id, so a capture saved in another tab between two clicks can never appear twice.
 *
 * Each row can be deleted behind an in-place confirm. Deleting only drops the row
 * locally: the cursor is a keyset position, not an offset, so the next page is unmoved.
 */
export function CaptureHistoryList({ initial }: { initial: CaptureHistoryPage }) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();
  const focus = useConfirmFocus(confirming);

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

      {items.length === 0 ? (
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
  const primary = CAPTURE_SOURCE_META[item.kinds[0] ?? "text"];
  const Icon = primary.icon;
  const created = new Date(item.createdAt);
  const counts = [
    item.peopleCount ? plural(item.peopleCount, "person", "people") : null,
    item.reminderCount ? plural(item.reminderCount, "reminder", "reminders") : null,
    item.photoCount ? plural(item.photoCount, "photo", "photos") : null,
  ].filter(Boolean);

  return (
    <li className="rounded-xl border border-border/60 bg-card transition-colors has-[a:hover]:border-primary/40 has-[a:focus-visible]:border-ring">
      {/* The delete button sits beside the link, not inside it: a button nested in an
          anchor is invalid and unreachable by keyboard. */}
      <div className="flex items-center">
        <Link
          href={`/capture/${item.id}`}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {item.thumbnailIds.length > 0 ? (
            <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- served by an
                  auth-gated API route, not a remote origin next/image can optimise. */}
              <img
                src={capturePhotoSrc(item.thumbnailIds[0]!)}
                alt=""
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
              />
              {item.photoCount > 1 && (
                <span className="absolute right-0.5 bottom-0.5 rounded bg-black/60 px-1 text-[10px] leading-4 font-medium text-white">
                  +{item.photoCount - 1}
                </span>
              )}
            </span>
          ) : (
            <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-5" aria-hidden />
            </span>
          )}

          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-ink">
                {item.title ?? primary.label}
              </span>
              {item.status === "undone" && (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  Undone
                </Badge>
              )}
            </span>
            {item.excerpt && (
              <span className="mt-0.5 line-clamp-2 block text-muted-foreground">
                {item.excerpt}
              </span>
            )}
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              {/* Local time only once hydrated: the server renders in its own timezone, and
                  a label that disagrees with the client's is a hydration mismatch. The
                  separator arrives with it, so the line never starts on a stray dot. */}
              {hydrated && (
                <>
                  <time dateTime={item.createdAt} title={format(created, "PPpp")}>
                    {timelineDayLabel(created)}, {format(created, "h:mm a")}
                  </time>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{item.kinds.map((k) => CAPTURE_SOURCE_META[k].label).join(" + ")}</span>
              {counts.length > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>{counts.join(", ")}</span>
                </>
              )}
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
