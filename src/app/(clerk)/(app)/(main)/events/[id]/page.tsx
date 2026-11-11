import { Suspense, cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { ArrowLeft, QrCode } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EventHero } from "@/components/events/event-hero";
import { AttendeeRoster, type RosterMatch } from "@/components/events/attendee-roster";
import { RosterImportPanel } from "@/components/events/roster-import-panel";
import { EventCompaniesPanel } from "@/components/events/event-companies-panel";
import { WhoToTalkToCard } from "@/components/events/who-to-talk-to-card";
import { PeopleYouMet } from "@/components/events/people-you-met";
import { EventNotesPanel } from "@/components/events/event-notes-panel";
import {
  getEvent,
  getEventCompanies,
  getRoster,
  getWhoToTalkTo,
  getRosterHistory,
  matchRosterToNetwork,
} from "@/actions/events";
import { RenderStamp } from "@/components/layout/render-stamp";
import { requireUserId } from "@/lib/auth";
import { liveEventFor } from "@/lib/cards/live-event";
import { isSurfaceLive } from "@/lib/surface-visibility";
import { AlsoHereCard } from "@/components/nearby/also-here-card";
import { alsoHereViewFor } from "@/lib/nearby/also-here-view";
import { isLiveAttendedEvent } from "@/lib/nearby/also-here";
import { buttonVariants } from "@/components/ui/button";
import { userTimeZone } from "@/lib/meeting-context";
import { ymdInZone } from "@/lib/reminder-due-bucket";
import { offsetMinutes } from "@/lib/events/wall-clock";
import { eventThemeVars } from "@/lib/events/theme";

/** Request-memoized so `generateMetadata` and the page share one read. */
const loadEvent = cache((id: string) => getEvent(id));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const event = await loadEvent(id).catch(() => null);
  return { title: event?.title || "Event" };
}

async function WhoToTalkTo({ eventId }: { eventId: string }) {
  const data = await getWhoToTalkTo(eventId);
  if (!data) return null;
  return <WhoToTalkToCard eventId={eventId} data={data} aiAvailable={data.aiAvailable} />;
}

async function Met({ eventId, rosterPromise }: { eventId: string; rosterPromise: Promise<RosterResult> }) {
  const result = await rosterPromise;
  return <PeopleYouMet eventId={eventId} rows={result.ok ? result.rows : []} />;
}

async function Companies({ eventId }: { eventId: string }) {
  const rows = await getEventCompanies(eventId);
  return <EventCompaniesPanel eventId={eventId} rows={rows} />;
}

type RosterResult =
  | { ok: true; rows: Awaited<ReturnType<typeof getRoster>> }
  | { ok: false };

async function Roster({
  eventId,
  rosterPromise,
  matchesPromise,
  historyPromise,
}: {
  eventId: string;
  rosterPromise: Promise<RosterResult>;
  matchesPromise: Promise<Awaited<ReturnType<typeof matchRosterToNetwork>>>;
  historyPromise: Promise<Awaited<ReturnType<typeof getRosterHistory>>>;
}) {
  const result = await rosterPromise;

  if (!result.ok) {
    return (
      <p className="rounded-xl border border-border/70 bg-card px-4 py-3 text-sm text-muted-foreground">
        The guest list could not be loaded just now. Refresh to try again — nothing has been
        lost.
      </p>
    );
  }

  const preview = await matchesPromise;
  const matches: RosterMatch[] = preview.flatMap((row) =>
    row.outcome === "match" && row.matchedContactId
      ? [
          {
            attendeeId: row.attendeeId,
            contactId: row.matchedContactId,
            contactName: row.matchedContactName,
          },
        ]
      : []
  );

  const history = await historyPromise;
  return (
    <AttendeeRoster
      eventId={eventId}
      rows={result.rows}
      matches={matches}
      history={history}
    />
  );
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await pageVisibilityGate("page.events");
  if (gate) return gate;

  const { id } = await params;

  const rosterPromise: Promise<RosterResult> = getRoster(id).then(
    (rows) => ({ ok: true as const, rows }),
    () => ({ ok: false as const })
  );
  const matchesPromise = matchRosterToNetwork(id).catch(() => []);
  const historyPromise = getRosterHistory(id).catch(() => []);

  const event = await loadEvent(id);
  if (!event) notFound();

  const userId = await requireUserId();
  const [zone, liveEvent, cardLive, alsoHereLive] = await Promise.all([
    userTimeZone(userId),
    liveEventFor(userId),
    isSurfaceLive(userId, "page.card"),
    isSurfaceLive(userId, "feature.also-here"),
  ]);
  // Only while the owner is at this event: that is when someone is standing in front of them.
  const showCardLink = cardLive && liveEvent?.id === event.id;
  // Every live event this user attends — not only liveEventFor's single pick — so the hide
  // control is reachable wherever they are findable (overlapping events).
  const showAlsoHere = alsoHereLive && (await isLiveAttendedEvent(userId, event.id));
  const eventDay = event.startsAt
    ? new Date(event.startsAt.getTime() + (offsetMinutes(event.timezone, event.startsAt) ?? 0) * 60_000)
        .toISOString()
        .slice(0, 10)
    : null;
  const past = !eventDay || eventDay <= ymdInZone(new Date(), zone);
  const accent = event.themeColor ?? "#6366f1";
  const themeVars = eventThemeVars(accent);

  return (
    <div
      className="event-theme relative mx-auto max-w-5xl space-y-6 pb-12"
      style={themeVars as React.CSSProperties}
    >
      <RenderStamp />

      {/* Dynamic Ambient Glow Mesh */}
      <div
        className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-[360px] w-[800px] -translate-x-1/2 rounded-full opacity-20 blur-[120px]"
        style={{ background: "var(--event-accent)" }}
        aria-hidden
      />

      <Link
        href="/events"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Back to events
      </Link>

      {/* Themed Event Hero Banner */}
      <EventHero event={event} />

      {showCardLink ? (
        <Link href="/card/show" className={buttonVariants({ variant: "outline" })}>
          <QrCode aria-hidden /> Share your card
        </Link>
      ) : null}

      {showAlsoHere ? (
        <Suspense fallback={<Skeleton className="h-28 w-full rounded-2xl" />}>
          <AlsoHere userId={userId} eventId={event.id} />
        </Suspense>
      ) : null}

      {event.enrichError ? (
        <p className="rounded-xl border border-border/70 bg-card px-4 py-3 text-sm text-muted-foreground">
          Orbit couldn&apos;t read that event page: {event.enrichError}
        </p>
      ) : null}

      {/* Event Notes & Debrief Notepad (Feeds into Orbit Knowledge Context) */}
      <div className="reveal-mount" style={{ "--reveal-delay": "40ms" } as React.CSSProperties}>
        <EventNotesPanel eventId={event.id} initialNotes={event.notes} />
      </div>

      {past ? (
        <div className="reveal-mount" style={{ "--reveal-delay": "50ms" } as React.CSSProperties}>
          <Suspense fallback={<Skeleton className="h-28 w-full rounded-2xl" />}>
            <Met eventId={event.id} rosterPromise={rosterPromise} />
          </Suspense>
        </div>
      ) : null}

      {/* Suggested People to Reach Out To / Follow Up With (Available for Both Upcoming & Past) */}
      <div className="reveal-mount" style={{ "--reveal-delay": "60ms" } as React.CSSProperties}>
        <Suspense fallback={null}>
          <WhoToTalkTo eventId={event.id} />
        </Suspense>
      </div>

      {/* Roster Import Panel */}
      <div className="reveal-mount" style={{ "--reveal-delay": "70ms" } as React.CSSProperties}>
        <RosterImportPanel eventId={event.id} />
      </div>

      {/* Companies & Sponsors */}
      <div className="reveal-mount" style={{ "--reveal-delay": "80ms" } as React.CSSProperties}>
        <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
          <Companies eventId={event.id} />
        </Suspense>
      </div>

      {/* Full Attendee Roster with Automatic LinkedIn Finder */}
      <div className="reveal-mount" style={{ "--reveal-delay": "100ms" } as React.CSSProperties}>
        <h2 className="mb-3 font-[family-name:var(--font-display)] text-xl text-ink">
          Guest List & Attendees
        </h2>
        <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
          <Roster
            eventId={event.id}
            rosterPromise={rosterPromise}
            matchesPromise={matchesPromise}
            historyPromise={historyPromise}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** Other opted-in Orbit users at this live event; streamed so the page never waits on it. */
async function AlsoHere({ userId, eventId }: { userId: string; eventId: string }) {
  const view = await alsoHereViewFor(userId, eventId).catch(() => null);
  return view ? <AlsoHereCard eventId={eventId} view={view} /> : null;
}
