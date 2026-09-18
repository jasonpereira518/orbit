"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronRight, History } from "lucide-react";
import { listCaptureHistory } from "@/actions/capture";
import type { CaptureHistoryItem, CaptureHistoryPage } from "@/lib/capture-history";
import { timelineDayLabel } from "@/lib/timeline-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAPTURE_SOURCE_META, capturePhotoSrc } from "@/components/capture/capture-source-meta";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

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
 */
export function CaptureHistoryList({ initial }: { initial: CaptureHistoryPage }) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, start] = useTransition();

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
            <CaptureHistoryRow key={item.id} item={item} />
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

function CaptureHistoryRow({ item }: { item: CaptureHistoryItem }) {
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
    <li>
      <Link
        href={`/capture/${item.id}`}
        className="group flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-3 text-sm transition-colors hover:border-primary/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
    </li>
  );
}
