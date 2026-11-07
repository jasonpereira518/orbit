"use client";

/**
 * The rows of /meetings (recorded and Granola), with "Load more". The first page arrives from
 * the server; later pages are a server action, merged by id so a refresh that overlaps cannot
 * repeat one. The page keys this on the search and source, so it never shows stale rows.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { CalendarDays, Clock, Loader2, Mic, Monitor, Users, Video } from "lucide-react";
import { listMeetingsPage } from "@/actions/meetings";
import { GranolaMark } from "@/components/settings/provider-marks";
import { Button } from "@/components/ui/button";
import { formatMeetingDuration } from "@/lib/format-meeting-duration";
import { formatElapsed } from "@/lib/format-elapsed";
import type { MeetingListItem, MeetingSourceFilter, MeetingsPage } from "@/lib/meetings-list";
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

const CALL: Record<string, string> = {
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Teams",
  webex: "Webex",
};

/** The row's left tile: where the meeting came from, named in its tooltip. */
function MeetingKind({ m }: { m: MeetingListItem }) {
  const label =
    m.source === "granola"
      ? "Granola note"
      : m.call
        ? `${CALL[m.call] ?? "Video"} call`
        : m.sharedScreen
          ? "Recorded from a shared tab or screen"
          : "Recorded in the room";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted/60 text-muted-foreground"
    >
      {m.source === "granola" ? (
        <GranolaMark className="size-5" />
      ) : m.call ? (
        <Video className="size-4" />
      ) : m.sharedScreen ? (
        <Monitor className="size-4" />
      ) : (
        <Mic className="size-4" />
      )}
    </span>
  );
}

function hideIfBlank(img: HTMLImageElement | null) {
  if (img?.complete && img.naturalWidth <= 1) img.hidden = true;
}

function meetingHref(m: MeetingListItem, q: string): string {
  const base = m.source === "granola" ? `/meetings/g/${m.id}` : `/meetings/${m.id}`;
  return q ? `${base}?q=${encodeURIComponent(q)}` : base;
}

export function MeetingsList({
  initial,
  q,
  source = "all",
}: {
  initial: MeetingsPage;
  q: string;
  source?: MeetingSourceFilter;
}) {
  const [items, setItems] = useState<MeetingListItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [pending, start] = useTransition();

  const loadMore = () =>
    start(async () => {
      const res = await listMeetingsPage(q || null, cursor, source);
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
      <div className="rounded-2xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
        {q ? (
          <>No meeting mentions “{q}”.</>
        ) : source === "granola" ? (
          <>
            No Granola meetings yet. Connect Granola in{" "}
            <Link href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
              Settings
            </Link>{" "}
            and its notes land here.
          </>
        ) : (
          <>No meetings yet. Record one above and it will be kept here.</>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {items.map((m) => (
          <li key={m.id}>
            <Link
              href={meetingHref(m, q)}
              className="flex gap-3 rounded-2xl border border-border/70 bg-card p-4 transition-colors hover:border-primary/40 hover:bg-primary/[0.02]"
            >
              <MeetingKind m={m} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <span className="min-w-0 truncate">{m.title || "Untitled meeting"}</span>
                  {m.companies.map((c) => (
                    // eslint-disable-next-line @next/next/no-img-element -- a 16px same-origin favicon; next/image buys nothing here.
                    <img
                      key={c.domain}
                      src={`/api/logos/${c.domain}`}
                      alt={c.name}
                      title={c.name}
                      width={16}
                      height={16}
                      loading="lazy"
                      className="size-4 shrink-0 rounded-sm"
                      // A miss is the route's 1×1 blank (or an error): drop it rather than keep an
                      // empty 16px slot. The ref catches one that settled before hydration.
                      ref={hideIfBlank}
                      onLoad={(e) => hideIfBlank(e.currentTarget)}
                      onError={(e) => {
                        e.currentTarget.hidden = true;
                      }}
                    />
                  ))}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="size-3.5" /> {whenLabel(m.startedAt)}
                  </span>
                  {m.source === "orbit" && (
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="size-3.5" /> {formatMeetingDuration(m.durationMs)}
                    </span>
                  )}
                  {m.attendees.length > 0 && (
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="size-3.5" /> {guestsLabel(m.attendees)}
                    </span>
                  )}
                </p>
                {m.match ? (
                  <p className="mt-2 rounded-lg bg-muted/40 px-3 py-2 text-sm text-foreground">
                    {m.source === "orbit" && (
                      <span className="mr-2 font-mono text-xs tabular-nums text-muted-foreground">
                        {formatElapsed(m.match.startMs)}
                      </span>
                    )}
                    {m.match.excerpt}
                  </p>
                ) : (
                  m.summary && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{m.summary}</p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {cursor && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" disabled={pending} onClick={loadMore}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
