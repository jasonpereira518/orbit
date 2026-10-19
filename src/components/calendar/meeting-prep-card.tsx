"use client";

/**
 * "Prep · Pilot sync in 12 min" in the bottom-right stack, from fifteen minutes before a
 * meeting with someone the user knows until the record nudge takes the corner at five.
 *
 * The meeting comes from the app pulse (`nextMeeting`), so there is no poll of its own. "Show
 * brief" loads `getMeetingPrep` — the stored brief, the last few touches and what is open, with
 * no model call — and "Ask chat" hands the meeting to chat for a written briefing.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Lightbulb, Loader2, Search, UserPlus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { addGuestFromBrief, getMeetingPrep, getTalkingPoints, lookUpGuest, type MeetingPrep } from "@/actions/calendar-prep";
import type { TalkingPointsResult } from "@/lib/meeting-talking-points";
import { useAppPulse } from "@/lib/app-pulse-store";
import { NUDGE_LEAD_MS } from "@/lib/meeting-nudge";
import { useNow } from "@/lib/use-now";
import { createDismissStore } from "@/lib/dismissed-ids";
import { syncTimeZoneCookie } from "@/lib/tz-cookie";
import { cn } from "@/lib/utils";

const PREP_LEAD_MS = 15 * 60_000;

const prepDismissals = createDismissStore("orbit:meeting-prep-dismissed:v1");

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
  prepDismissals.useVersion();
  if (!meeting || now === null || prepDismissals.isDismissed(meeting.eventId)) return null;
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

      {state.kind === "open" && <PrepBrief prep={state.prep} eventId={offer.eventId} />}
      {state.kind === "error" && <p className="text-xs text-destructive">{state.message}</p>}
      <TalkingPoints eventId={offer.eventId} />

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
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => prepDismissals.dismiss(offer.eventId)}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function PrepBrief({ prep, eventId }: { prep: MeetingPrep; eventId: string }) {
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
      {prep.linkedEvent && <LinkedEventBlock event={prep.linkedEvent} />}
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
          {p.dueBefore.length > 0 && (
            <div>
              <p className="font-medium text-warning">Due before this meeting</p>
              <ul className="list-disc pl-4 text-ink">
                {p.dueBefore.slice(0, 3).map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </div>
          )}
          {p.open.length > 0 && (
            <ul className="list-disc pl-4 text-ink">
              {p.open.slice(0, 3).map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          )}
          {p.fromNotes[0] && (
            <p className="text-muted-foreground">
              From your notes{p.fromNotes[0].day ? ` (${p.fromNotes[0].day})` : ""}: “{p.fromNotes[0].snippet}”
            </p>
          )}
        </div>
      ))}
      {prep.notInOrbit.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground">Not in Orbit yet</p>
          {prep.notInOrbit.map((p) => (
            <GuestRow key={p.email || p.name} guest={p} eventId={eventId} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The Luma/Partiful/Eventbrite event behind the invite: hosts, room size, who to find. */
function LinkedEventBlock({ event }: { event: NonNullable<MeetingPrep["linkedEvent"]> }) {
  const facts = [
    event.hosts.length ? `Hosted by ${event.hosts.slice(0, 3).join(", ")}` : null,
    event.guestCount ? `${event.guestCount} going` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5">
      <Link href={`/events/${event.eventId}`} className="font-medium text-ink underline-offset-2 hover:underline">
        {event.title}
      </Link>
      {facts.length > 0 && <p className="text-muted-foreground">{facts.join(" · ")}</p>}
      {event.worthFinding.length > 0 && (
        <>
          <p className="text-muted-foreground">Worth finding</p>
          <ul className="list-disc pl-4 text-ink">
            {event.worthFinding.map((r, i) => (
              <li key={i}>
                {r.name}
                {(r.title || r.company) && (
                  <span className="text-muted-foreground"> · {[r.title, r.company].filter(Boolean).join(" at ")}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

type Guest = MeetingPrep["notInOrbit"][number];

/**
 * A guest who isn't a contact: their company from the email domain, and "Look up" — Find
 * people's research — for more. A looked-up guest's "Add" saves the brief, work history and all.
 */
function GuestRow({ guest, eventId }: { guest: Guest; eventId: string }) {
  const router = useRouter();
  const [profile, setProfile] = useState(guest.profile);
  const [state, setState] = useState<"idle" | "loading" | "adding" | { message: string }>("idle");
  const company = profile?.company ?? guest.company;
  const role = profile?.title ? `${profile.title}${company ? ` at ${company}` : ""}` : company;

  const lookUp = async () => {
    setState("loading");
    const res = await lookUpGuest(eventId, guest.email);
    if (!res.ok) return setState({ message: res.error });
    setProfile(res.profile);
    setState("idle");
  };

  const prefill = new URLSearchParams({ name: guest.name, email: guest.email });
  if (company) prefill.set("company", company);
  if (profile?.title) prefill.set("title", profile.title);
  const add = async () => {
    if (!profile) return router.push(`/contacts/new?${prefill}`);
    setState("adding");
    const res = await addGuestFromBrief(profile.key);
    // An expired brief still has the form to fall back on.
    if (!res.ok) return router.push(`/contacts/new?${prefill}`);
    router.push(`/contacts/${res.contactId}`);
  };

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate">
          {guest.name || guest.email}
          {role && <span className="text-muted-foreground"> · {role}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {!profile && guest.company && (
            <button
              type="button"
              onClick={lookUp}
              disabled={state === "loading"}
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline disabled:opacity-60"
            >
              {state === "loading" ? <Loader2 className="size-3 animate-spin" /> : <Search className="size-3" />} Look up
            </button>
          )}
          <button
            type="button"
            onClick={add}
            disabled={state === "adding"}
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline disabled:opacity-60"
          >
            {state === "adding" ? <Loader2 className="size-3 animate-spin" /> : <UserPlus className="size-3" />} Add
          </button>
        </span>
      </div>
      {profile?.headline && <p className="text-muted-foreground">{profile.headline}</p>}
      {profile?.summary && <p className="text-muted-foreground">{profile.summary}</p>}
      {profile && (
        <Link href="/find" className="text-primary underline-offset-2 hover:underline">
          Full brief in Find people
        </Link>
      )}
      {typeof state === "object" && <p className="text-muted-foreground">{state.message}</p>}
    </div>
  );
}

/** "Talking points": what to bring up, each with the fact it came from. */
function TalkingPoints({ eventId }: { eventId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "done"; result: TalkingPointsResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <button
        type="button"
        disabled={state.kind === "loading"}
        onClick={async () => {
          setState({ kind: "loading" });
          const res = await getTalkingPoints(eventId);
          setState(res.ok ? { kind: "done", result: res.result } : { kind: "error", message: res.error });
        }}
        className="inline-flex items-center gap-1 self-start text-xs text-primary underline-offset-2 hover:underline disabled:opacity-60"
      >
        {state.kind === "loading" ? <Loader2 className="size-3 animate-spin" /> : <Lightbulb className="size-3" />}
        Talking points
      </button>
    );
  }
  if (state.kind === "error") return <p className="text-xs text-destructive">{state.message}</p>;
  const { points, source } = state.result;
  return (
    <div className="space-y-1 border-t border-border/60 pt-2 text-xs">
      <p className="text-muted-foreground">Talking points{source === "facts" ? " · from what Orbit knows" : ""}</p>
      {points.length === 0 ? (
        <p className="text-muted-foreground">Nothing on file yet to bring up with them.</p>
      ) : (
        <ul className="space-y-1">
          {points.map((p, i) => (
            <li key={i}>
              <span className="text-ink">{p.text}</span>
              <span className="block text-muted-foreground">{p.basis}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
