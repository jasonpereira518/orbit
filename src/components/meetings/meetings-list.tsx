"use client";

/**
 * The rows of /meetings, with "Load more". The first page arrives from the server; later
 * pages are a server action, merged by id so a refresh that overlaps cannot repeat one.
 * `key={q}` on the page remounts this when the search changes, so it never shows stale rows.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { CalendarDays, Clock, Loader2, Mic, Users } from "lucide-react";
import { listMeetingsPage } from "@/actions/meetings";
import { Button, buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CARD_HOVER } from "@/lib/interaction";
import { cn } from "@/lib/utils";
import { formatMeetingDuration } from "@/lib/format-meeting-duration";
import { formatElapsed } from "@/lib/format-elapsed";
import type { MeetingListItem, MeetingsPage } from "@/lib/meetings-list";
import { toast } from "@/lib/toast";

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function guestsLabel(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

export function MeetingsList({ initial, q }: { initial: MeetingsPage; q: string }) {
  const [items, setItems] = useState<MeetingListItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [pending, start] = useTransition();

  const loadMore = () =>
    start(async () => {
      const res = await listMeetingsPage(q || null, cursor);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setItems((prev) => {
        const have = new Set(prev.map((m) => m.id));
        return [...prev, ...res.items.filter((m) => !have.has(m.id))];
      });
      setCursor(res.nextCursor);
    });

  if (items.length === 0) {
    return (
      q ? (
        <EmptyState
          icon={Mic}
          title={<>No meeting mentions “{q}”</>}
          description="Try a person, a topic, or a different phrase."
          action={
            <Link href="/meetings" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Clear search
            </Link>
          }
        />
      ) : (
        <EmptyState
          icon={Mic}
          title="No finished meetings yet"
          description="Record one from Capture and it will be kept here."
          action={
            <Link href="/capture?mode=meeting" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Record a meeting
            </Link>
          }
        />
      )
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {items.map((m) => (
          <li key={m.id}>
            <Link
              href={`/meetings/${m.id}${q ? `?q=${encodeURIComponent(q)}` : ""}`}
              className={cn("block rounded-xl border border-border-subtle bg-card p-4", CARD_HOVER)}
            >
              <p className="font-medium text-foreground">{m.title || "Untitled meeting"}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="size-3.5" aria-hidden /> {whenLabel(m.startedAt)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-3.5" aria-hidden /> {formatMeetingDuration(m.durationMs)}
                </span>
                {m.attendees.length > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="size-3.5" aria-hidden /> {guestsLabel(m.attendees)}
                  </span>
                )}
              </p>
              {m.match ? (
                <p className="mt-2 rounded-lg bg-surface-inset px-3 py-2 text-sm text-foreground">
                  <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">
                    {formatElapsed(m.match.startMs)}
                  </span>
                  {m.match.excerpt}
                </p>
              ) : (
                m.summary && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{m.summary}</p>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {cursor && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" disabled={pending} onClick={loadMore}>
            {pending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
            {pending ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
