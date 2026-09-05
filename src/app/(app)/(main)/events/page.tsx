import { Suspense } from "react";
import { EventsHeader } from "@/components/events/events-header";
import { EventCard } from "@/components/events/event-card";
import { AddEventDialog } from "@/components/events/add-event-dialog";
import { EventConnectionsCard } from "@/components/events/event-connections-card";
import { EventsListSkeleton } from "@/components/loading/page-skeletons";
import { getEventConnections, listEvents } from "@/actions/events";

async function ConnectionsSection() {
  const { connections, eventbriteConfigured } = await getEventConnections();
  return (
    <EventConnectionsCard
      connections={connections}
      eventbriteConfigured={eventbriteConfigured}
    />
  );
}

async function EventsList() {
  const events = await listEvents();

  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          No events yet. Add one by pasting its link — a Luma, Eventbrite or Partiful page all
          work — and Orbit will pull in the details.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {events.map((event) => (
        <EventCard key={event.id} event={event} />
      ))}
    </div>
  );
}

export default function EventsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <EventsHeader />
        <AddEventDialog />
      </div>

      {/* fallback={null}: this card renders as a compact "nothing connected" state, and a
          skeleton that resolves into it reads as a glitch. */}
      <div className="reveal-mount" style={{ "--reveal-delay": "60ms" } as React.CSSProperties}>
        <Suspense fallback={null}>
          <ConnectionsSection />
        </Suspense>
      </div>

      <div className="reveal-mount" style={{ "--reveal-delay": "120ms" } as React.CSSProperties}>
        <Suspense fallback={<EventsListSkeleton />}>
          <EventsList />
        </Suspense>
      </div>
    </div>
  );
}
