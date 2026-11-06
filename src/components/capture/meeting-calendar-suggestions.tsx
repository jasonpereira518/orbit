"use client";

/**
 * "From your calendar" on the meeting setup form: the meetings around now, one click to fill
 * in the title and who is on the call.
 *
 * Quiet by design. It is a convenience, so a failed read, an empty calendar, and a user with
 * no Google connection all render nothing — the form below works identically. The one case
 * that speaks is a Google connection that exists but cannot read the calendar (an older
 * consent, or a revoked one), because that is something the user can fix in one place.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Check } from "lucide-react";
import { getMeetingCandidates } from "@/actions/meetings";
import type { MeetingCandidate } from "@/lib/meeting-calendar";
import { Button } from "@/components/ui/button";

/** `at` is when the calendar was read: "Now" is judged against that, not a clock read in render. */
type Loaded = { status: "ok" | "needs-scope" | "reauth"; events: MeetingCandidate[]; at: number };

function timeLabel(c: MeetingCandidate, now: number): string {
  const start = new Date(c.startIso);
  const end = c.endIso ? new Date(c.endIso).getTime() : start.getTime();
  if (start.getTime() <= now && now <= end) return "Now";
  return start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function whoLabel(c: MeetingCandidate): string {
  if (c.attendees.length === 0) return "Guest list hidden";
  const names = c.attendees.slice(0, 3).map((a) => a.name);
  const more = c.attendees.length - names.length;
  return more > 0 ? `${names.join(", ")} +${more}` : names.join(", ");
}

export function MeetingCalendarSuggestions({ onUse }: { onUse: (meeting: MeetingCandidate) => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [usedId, setUsedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMeetingCandidates()
      .then((res) => {
        if (cancelled || !res.ok || res.status === "not-connected") return;
        setLoaded({ status: res.status, events: res.events, at: Date.now() });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) return null;

  if (loaded.status !== "ok") {
    return (
      <p className="text-xs text-muted-foreground">
        Orbit can&apos;t read your Google Calendar yet.{" "}
        <Link href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
          Reconnect Google in Settings
        </Link>{" "}
        to fill this in from your next meeting.
      </p>
    );
  }

  if (loaded.events.length === 0) return null;

  const now = loaded.at;
  return (
    <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/[0.03] p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <CalendarClock className="size-4 text-muted-foreground" /> From your calendar
      </p>
      <ul className="space-y-1.5">
        {loaded.events.slice(0, 3).map((c) => (
          <li key={c.id} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
              {timeLabel(c, now)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{c.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{whoLabel(c)}</span>
            </span>
            <Button
              type="button"
              size="sm"
              variant={usedId === c.id ? "ghost" : "outline"}
              className="shrink-0 gap-1.5"
              onClick={() => {
                onUse(c);
                setUsedId(c.id);
              }}
            >
              {usedId === c.id ? (
                <>
                  <Check className="size-3.5" /> Filled in
                </>
              ) : (
                "Use this"
              )}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
