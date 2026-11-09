import { useEffect, useState } from "react";
import { CalendarDays, Users } from "lucide-react";
import type { PageContext, RecentEventsResponse } from "@contract";
import { APP_URL } from "@/lib/env";
import type { OrbitApi } from "@/lib/api";
import { Notice } from "../components/Notice";
import { Avatar, Button, Meta, MicroLabel } from "../components/ui";

type RecentEvent = RecentEventsResponse["events"][number];

function when(startsAt: string | null): string {
  if (!startsAt) return "";
  return new Date(startsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * LinkedIn → My Network → Connections: "Log at an event". Pick the event, tick the people you
 * connected with there, and Orbit opens that event's debrief with them listed, where each one
 * gets a note and a follow-up before becoming a contact. Only the ticked names and profile
 * links are sent, and only on the button.
 */
export function LogConnectionsView({ page, api }: { page: PageContext; api: OrbitApi }) {
  const people = (page.candidates ?? []).filter((c) => c.profileUrl);
  const [events, setEvents] = useState<RecentEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  useEffect(() => {
    const controller = new AbortController();
    api
      .recentEvents(controller.signal)
      .then((res) => {
        setEvents(res.events);
        setEventId(res.events[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "Couldn't load your events.");
      });
    return () => controller.abort();
  }, [api]);

  if (people.length === 0) {
    return (
      <Notice
        icon={<Users size={18} />}
        title="No connections showing"
        body="Sort your connections by Recently added so the people you just met are at the top, then click the Orbit icon again."
      />
    );
  }
  if (loadError) return <Notice icon={<CalendarDays size={18} />} title="Couldn't load your events" body={loadError} />;
  if (events && events.length === 0) {
    return (
      <Notice
        icon={<CalendarDays size={18} />}
        title="No recent events"
        body="Add the event in Orbit first (Events → Add event, its name is enough), then come back here."
        action={
          <Button variant="outline" onClick={() => chrome.tabs.create({ url: `${APP_URL}/events` })}>
            Open Events
          </Button>
        }
      />
    );
  }

  const toggle = (url: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const chosen = people.filter((p) => ticked.has(p.profileUrl!));
  const event = events?.find((e) => e.id === eventId) ?? null;

  const log = async () => {
    if (!event || chosen.length === 0) return;
    setState({ kind: "saving" });
    try {
      const result = await api.logConnections({ eventId: event.id, people: chosen });
      // Ids only in the URL; the debrief reads the names back from Orbit.
      void chrome.tabs.create({
        url: `${APP_URL}/capture?eventId=${result.eventId}&attendees=${result.attendeeIds.join(",")}`,
      });
      setState({ kind: "idle" });
      setTicked(new Set());
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't log those people." });
    }
  };

  return (
    <div className="scroll-area flex-1 space-y-3 px-3 py-3">
      <div>
        <MicroLabel>Log at an event</MicroLabel>
        <p className="mt-1 text-[14px] font-medium leading-snug">Who did you meet?</p>
        <Meta>Tick the people you connected with, then pick the event.</Meta>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {events === null ? (
          <Meta>Loading your events…</Meta>
        ) : (
          events.map((e) => (
            <button
              key={e.id}
              onClick={() => setEventId(e.id)}
              className={
                e.id === eventId
                  ? "rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]"
                  : "rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)]"
              }
            >
              {e.title}
              {e.startsAt ? ` · ${when(e.startsAt)}` : ""}
            </button>
          ))
        )}
      </div>

      <ul className="space-y-1">
        {people.map((person) => (
          <li key={person.profileUrl}>
            <label className="flex cursor-pointer items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={ticked.has(person.profileUrl!)}
                onChange={() => toggle(person.profileUrl!)}
                className="h-3.5 w-3.5 accent-[var(--primary)]"
              />
              <Avatar name={person.name} size={22} />
              <span className="min-w-0">
                <span className="block truncate">{person.name}</span>
                {person.subtitle ? <Meta className="block truncate">{person.subtitle}</Meta> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="space-y-1.5">
        <Button onClick={() => void log()} disabled={!event || chosen.length === 0 || state.kind === "saving"}>
          {state.kind === "saving"
            ? "Logging…"
            : chosen.length === 0
              ? "Tick who you met"
              : `Log ${chosen.length} at ${event?.title ?? "the event"}`}
        </Button>
        {state.kind === "error" ? (
          <Meta className="text-[var(--destructive)]">{state.message}</Meta>
        ) : (
          <Meta>Opens Orbit to add a note and a follow-up for each. Nobody becomes a contact until you save.</Meta>
        )}
      </div>
    </div>
  );
}
