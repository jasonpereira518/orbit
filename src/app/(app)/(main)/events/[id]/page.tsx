import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { EventHero } from "@/components/events/event-hero";
import { AttendeeRoster } from "@/components/events/attendee-roster";
import { RosterImportPanel } from "@/components/events/roster-import-panel";
import { getEvent, getRoster } from "@/actions/events";

async function Roster({
  eventId,
  rosterPromise,
}: {
  eventId: string;
  rosterPromise: Promise<Awaited<ReturnType<typeof getRoster>>>;
}) {
  const rows = await rosterPromise;
  return <AttendeeRoster eventId={eventId} rows={rows} />;
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Started before the first await and `.catch()`-guarded, so the roster is already in
  // flight while the event row loads and an eager rejection cannot go unhandled.
  const rosterPromise = getRoster(id).catch(() => []);

  const event = await getEvent(id);
  // Before any Suspense boundary, so the route returns a real 404 rather than streaming a
  // shell and then discovering there is nothing to put in it.
  if (!event) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-8">
      <EventHero event={event} />

      {event.enrichError ? (
        <p className="rounded-xl border border-border/70 bg-card px-4 py-3 text-sm text-muted-foreground">
          Orbit couldn&apos;t read that event page: {event.enrichError}
        </p>
      ) : null}

      <div className="reveal-mount" style={{ "--reveal-delay": "60ms" } as React.CSSProperties}>
        <RosterImportPanel eventId={event.id} />
      </div>

      <div className="reveal-mount" style={{ "--reveal-delay": "120ms" } as React.CSSProperties}>
        <h2 className="mb-3 font-[family-name:var(--font-display)] text-xl text-ink">
          Who was there
        </h2>
        <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
          <Roster eventId={event.id} rosterPromise={rosterPromise} />
        </Suspense>
      </div>
    </div>
  );
}
