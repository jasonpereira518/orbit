"use client";

/**
 * The rows of /meetings (recorded and Granola), with "Load more". The first page arrives from
 * the server; later pages are a server action, merged by id so a refresh that overlaps cannot
 * repeat one. The page keys this on the search and source, so it never shows stale rows.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { CalendarDays, Clock, Loader2, Monitor, Users, Video } from "lucide-react";
import { listMeetingsPage } from "@/actions/meetings";
import { NOTE_SOURCE_LABEL, NoteSourceMark } from "@/components/capture/note-source-mark";
import { BrandLogo } from "@/components/ui/brand-logo";
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

const CALL: Record<string, { name: string; domain: string }> = {
  meet: { name: "Google Meet", domain: "meet.google.com" },
  zoom: { name: "Zoom", domain: "zoom.us" },
  teams: { name: "Teams", domain: "teams.microsoft.com" },
  webex: { name: "Webex", domain: "webex.com" },
};

/** The row's left tile: what kind of meeting it was — the call app, a shared screen, or the room. */
function MeetingKind({ m }: { m: MeetingListItem }) {
  const call = m.call ? CALL[m.call] : undefined;
  const label = m.call
    ? `${call?.name ?? "Video"} call`
    : m.sharedScreen
      ? "Recorded from a shared tab or screen"
      : m.source === "granola"
        ? "Meeting"
        : "Recorded in the room";
  const fallback = m.call ? <Video className="size-4" /> : m.sharedScreen ? <Monitor className="size-4" /> : <Users className="size-4" />;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted/60 text-muted-foreground"
    >
      {call ? <BrandLogo key={call.domain} domain={call.domain} name="" className="size-5" fallback={fallback} /> : fallback}
    </span>
  );
}

/** Top right: who took the notes. */
function NotesBy({ source }: { source: MeetingListItem["source"] }) {
  const label = `Notes by ${NOTE_SOURCE_LABEL[source]}`;
  return (
    <span role="img" aria-label={label} title={label} className="ml-auto shrink-0 pl-2">
      <NoteSourceMark source={source} className="size-4" />
    </span>
  );
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
                    <BrandLogo key={c.domain} domain={c.domain} name={c.name} />
                  ))}
                  <NotesBy source={m.source} />
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
