"use client";

/**
 * "Prep · Pilot sync in 12 min" in the bottom-right stack, from fifteen minutes before a
 * meeting with someone the user knows until the record nudge takes the corner at five.
 *
 * The meeting comes from the app pulse (`nextMeeting`), so there is no poll of its own. "Show
 * brief" loads `getMeetingPrep` — the stored brief, the last few touches and what is open, with
 * no model call — and "Ask chat" hands the meeting to chat for a written briefing.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CalendarClock, Loader2, UserPlus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { getMeetingPrep, type MeetingPrep } from "@/actions/calendar-prep";
import { useAppPulse } from "@/lib/app-pulse-store";
import { NUDGE_LEAD_MS } from "@/lib/meeting-nudge";
import { useNow } from "@/lib/use-now";
import { syncTimeZoneCookie } from "@/lib/tz-cookie";
import { cn } from "@/lib/utils";

const PREP_LEAD_MS = 15 * 60_000;
const DISMISSED_KEY = "orbit:meeting-prep-dismissed:v1";

// ── Dismissals: per device, per event ──────────────────────────────────────────────────
const dismissedInSession = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function isDismissed(eventId: string): boolean {
  if (dismissedInSession.has(eventId)) return true;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed) && parsed.includes(eventId);
  } catch {
    return false;
  }
}

function dismiss(eventId: string): void {
  dismissedInSession.add(eventId);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    const list = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...list, eventId].slice(-50)));
  } catch {
    // Storage blocked: the in-session set covers this tab.
  }
  version++;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export type PrepOffer = NonNullable<NonNullable<ReturnType<typeof useAppPulse>["pulse"]>["nextMeeting"]> & {
  minutes: number;
};

/** The meeting to offer prep for right now, or null. */
export function useMeetingPrepCard(): PrepOffer | null {
  // Mounted on every page, so this is where the browser's zone reaches the server: the Today
  // card reads the cookie and saves it, and the calendar tools read what was saved.
  useEffect(() => syncTimeZoneCookie(), []);
  const { pulse } = useAppPulse();
  const meeting = pulse?.nextMeeting ?? null;
  const now = useNow(30_000, meeting !== null);
  useSyncExternalStore(subscribe, () => version, () => 0);
  if (!meeting || now === null || isDismissed(meeting.eventId)) return null;
  const until = Date.parse(meeting.startIso) - now;
  if (until > PREP_LEAD_MS || until <= NUDGE_LEAD_MS) return null;
  return { ...meeting, minutes: Math.ceil(until / 60_000) };
}

export function MeetingPrepCard({ offer }: { offer: PrepOffer }) {
  const [state, setState] = useState<
    { kind: "closed" } | { kind: "loading" } | { kind: "open"; prep: MeetingPrep } | { kind: "error"; message: string }
  >({ kind: "closed" });

  const show = async () => {
    if (state.kind === "open") return setState({ kind: "closed" });
    setState({ kind: "loading" });
    const res = await getMeetingPrep(offer.eventId);
    if (!res.ok) setState({ kind: "error", message: res.error });
    else if (!res.prep) setState({ kind: "error", message: "That meeting is no longer on your calendar" });
    else setState({ kind: "open", prep: res.prep });
  };

  const ask = `/chat?q=${encodeURIComponent(`Prep me for “${offer.title}”`)}`;

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-card/95 p-3 shadow-lg backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">Prep · {offer.title || "Your meeting"}</p>
          <p className="truncate text-xs text-muted-foreground">
            in {offer.minutes} min{offer.people.length ? ` · with ${offer.people.join(", ")}` : ""}
          </p>
        </div>
      </div>

      {state.kind === "open" && <PrepBrief prep={state.prep} />}
      {state.kind === "error" && <p className="text-xs text-destructive">{state.message}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={show}
          disabled={state.kind === "loading"}
          aria-expanded={state.kind === "open"}
        >
          {state.kind === "loading" && <Loader2 className="size-3.5 animate-spin" />}
          {state.kind === "open" ? "Hide brief" : "Show brief"}
        </Button>
        <Link href={ask} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          Ask chat
        </Link>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => dismiss(offer.eventId)}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function PrepBrief({ prep }: { prep: MeetingPrep }) {
  return (
    <div className="max-h-[50vh] space-y-3 overflow-y-auto border-t border-border/60 pt-2 text-xs">
      {prep.lastTime && (prep.lastTime.actionItems.length > 0 || prep.lastTime.decisions.length > 0) && (
        <div className="space-y-0.5">
          <p className="text-muted-foreground">Last time ({prep.lastTime.day})</p>
          <ul className="list-disc pl-4 text-ink">
            {[...prep.lastTime.actionItems, ...prep.lastTime.decisions].slice(0, 4).map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {prep.people.map((p) => (
        <div key={p.contactId} className="space-y-0.5">
          <Link href={`/contacts/${p.contactId}`} className="font-medium text-ink underline-offset-2 hover:underline">
            {p.name}
          </Link>
          {(p.title || p.company) && (
            <span className="text-muted-foreground"> · {[p.title, p.company].filter(Boolean).join(" at ")}</span>
          )}
          {p.standing && <p className="text-muted-foreground">{p.standing}</p>}
          {p.nextStep && <p className="text-ink">Next: {p.nextStep}</p>}
          {p.recent[0] ? (
            <p className="text-muted-foreground">
              Last: {p.recent[0].day} — {p.recent[0].summary || p.recent[0].type.replace(/_/g, " ")}
            </p>
          ) : (
            <p className="text-muted-foreground">First time meeting</p>
          )}
          {p.open.length > 0 && (
            <ul className="list-disc pl-4 text-ink">
              {p.open.slice(0, 3).map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {prep.notInOrbit.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground">Not in Orbit yet</p>
          {prep.notInOrbit.map((p) => (
            <div key={p.email || p.name} className="flex items-center justify-between gap-2">
              <span className="truncate">{p.name || p.email}</span>
              <Link
                href={`/contacts/new?${new URLSearchParams({ name: p.name, email: p.email })}`}
                className="inline-flex shrink-0 items-center gap-1 text-primary underline-offset-2 hover:underline"
              >
                <UserPlus className="size-3" /> Add
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
