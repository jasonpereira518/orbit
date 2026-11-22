"use client";

/**
 * "From your calendar" on the meeting setup form: detects upcoming or in-progress
 * meetings and suggests starting them with one click, taking all calendar details
 * (title, attendees, agenda, call link) as context.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Check, Radio, Video, ChevronDown } from "lucide-react";
import { getMeetingCandidates } from "@/actions/meetings";
import type { MeetingCandidate } from "@/lib/meeting-calendar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** `at` is when the calendar was read: "Now" is judged against that, not a clock read in render. */
type Loaded = { status: "ok" | "needs-scope" | "reauth"; events: MeetingCandidate[]; at: number };

const CALL_LABELS: Record<string, string> = {
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Teams",
  webex: "Webex",
};

function timeLabel(c: MeetingCandidate, now: number): string {
  const start = new Date(c.startIso).getTime();
  const end = c.endIso ? new Date(c.endIso).getTime() : start;
  if (start <= now && now <= end) return "Happening now";
  const diffMin = Math.round((start - now) / 60_000);
  if (diffMin > 0 && diffMin <= 60) return `Starts in ${diffMin} min`;
  if (diffMin < 0 && Math.abs(diffMin) <= 30) return `Started ${Math.abs(diffMin)} min ago`;
  return new Date(c.startIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function timeRange(c: MeetingCandidate): string {
  const start = new Date(c.startIso);
  const startStr = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (!c.endIso) return startStr;
  const end = new Date(c.endIso);
  const endStr = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${startStr} – ${endStr}`;
}

function whoLabel(c: MeetingCandidate): string {
  if (c.attendees.length === 0) return "Guest list hidden";
  const names = c.attendees.slice(0, 3).map((a) => a.name);
  const more = c.attendees.length - names.length;
  return more > 0 ? `${names.join(", ")} +${more}` : names.join(", ");
}

function isUpcomingSoon(c: MeetingCandidate, now: number): boolean {
  const start = new Date(c.startIso).getTime();
  const end = c.endIso ? new Date(c.endIso).getTime() : start + 30 * 60_000;
  // In progress, or starting within 30 minutes, or started within the last 15 minutes
  return (
    (start <= now && now <= end) ||
    (start > now && start - now <= 30 * 60_000) ||
    (now > start && now - start <= 15 * 60_000)
  );
}

export function MeetingCalendarSuggestions({
  onUse,
  onStart,
  initialEventKey,
}: {
  onUse: (meeting: MeetingCandidate) => void;
  onStart?: (meeting: MeetingCandidate) => void;
  initialEventKey?: string | null;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [usedId, setUsedId] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getMeetingCandidates()
      .then((res) => {
        if (cancelled || !res.ok || res.status === "not-connected") return;
        setLoaded({ status: res.status, events: res.events, at: Date.now() });

        if (initialEventKey && res.events.length > 0) {
          const match = res.events.find((e) => e.eventKey === initialEventKey || e.id === initialEventKey);
          if (match) {
            onUse(match);
            setUsedId(match.id);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialEventKey, onUse]);

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
  const top = loaded.events[0];
  const isTopUpcoming = isUpcomingSoon(top, now);
  const isTopActive = (() => {
    const start = new Date(top.startIso).getTime();
    const end = top.endIso ? new Date(top.endIso).getTime() : start;
    return start <= now && now <= end;
  })();
  const others = isTopUpcoming ? loaded.events.slice(1) : loaded.events;

  return (
    <div className="space-y-3">
      {/* Featured Upcoming Meeting Suggestion */}
      {isTopUpcoming && (
        <div className="rounded-xl border border-primary/40 bg-gradient-to-r from-primary/[0.07] to-primary/[0.02] p-3.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                isTopActive
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                  : "bg-primary/15 text-primary"
              )}
            >
              {isTopActive ? (
                <>
                  <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Happening now
                </>
              ) : (
                <>
                  <CalendarClock className="size-3" />
                  {timeLabel(top, now)}
                </>
              )}
            </span>

            {top.call && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Video className="size-3" />
                {CALL_LABELS[top.call] ?? "Video call"}
              </span>
            )}
          </div>

          <div className="mt-2 space-y-1">
            <h3 className="text-base font-semibold text-foreground tracking-tight">{top.title}</h3>
            <p className="text-xs text-muted-foreground">
              <span className="tabular-nums font-medium">{timeRange(top)}</span>
              {" · "}
              <span>{whoLabel(top)}</span>
            </p>
            {top.agenda && (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground italic bg-background/50 rounded-md p-1.5 border border-border/40">
                <span className="font-medium not-italic text-foreground">Agenda:</span> {top.agenda}
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onStart && (
              <Button
                type="button"
                size="sm"
                className="gap-1.5 shadow-sm"
                onClick={() => {
                  onUse(top);
                  setUsedId(top.id);
                  onStart(top);
                }}
              >
                <Radio className="size-3.5 animate-pulse text-white" />
                Start meeting
              </Button>
            )}

            <Button
              type="button"
              size="sm"
              variant={usedId === top.id ? "ghost" : "outline"}
              className="gap-1.5"
              onClick={() => {
                onUse(top);
                setUsedId(top.id);
              }}
            >
              {usedId === top.id ? (
                <>
                  <Check className="size-3.5 text-emerald-600" /> Details applied
                </>
              ) : (
                "Fill details"
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Other calendar events */}
      {others.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-border/60 bg-muted/20 p-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CalendarClock className="size-3.5" />
              {isTopUpcoming ? "Other events on your calendar" : "From your calendar"}
            </p>
            {isTopUpcoming && others.length > 2 && (
              <button
                type="button"
                className="flex items-center gap-1 text-2xs text-primary underline-offset-2 hover:underline"
                onClick={() => setShowOthers((prev) => !prev)}
              >
                {showOthers ? "Show less" : `Show ${others.length}`}
                <ChevronDown className={cn("size-3 transition-transform", showOthers && "rotate-180")} />
              </button>
            )}
          </div>

          <ul className="space-y-1.5 pt-1">
            {(isTopUpcoming && !showOthers ? others.slice(0, 2) : others.slice(0, 5)).map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-0.5">
                <span className="w-16 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                  {timeLabel(c, now)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{c.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{whoLabel(c)}</span>
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={usedId === c.id ? "ghost" : "outline"}
                    className="h-7 px-2.5 text-xs gap-1"
                    onClick={() => {
                      onUse(c);
                      setUsedId(c.id);
                    }}
                  >
                    {usedId === c.id ? (
                      <>
                        <Check className="size-3" /> Filled
                      </>
                    ) : (
                      "Use"
                    )}
                  </Button>
                  {onStart && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-primary hover:text-primary"
                      onClick={() => {
                        onUse(c);
                        setUsedId(c.id);
                        onStart(c);
                      }}
                    >
                      Start
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
