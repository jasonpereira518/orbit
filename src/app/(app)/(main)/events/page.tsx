import { Suspense } from "react";
import { EventsHeader } from "@/components/events/events-header";
import { EventCard } from "@/components/events/event-card";
import { AddEventDialog } from "@/components/events/add-event-dialog";
import { EventConnectionsCard } from "@/components/events/event-connections-card";
import { EventsListSkeleton } from "@/components/loading/page-skeletons";
import { getEventConnections, listEvents, listHiddenEvents } from "@/actions/events";

async function ConnectionsSection() {
  const { connections, eventbriteConfigured, googleConnected } = await getEventConnections();
  return (
    <EventConnectionsCard
      connections={connections}
      eventbriteConfigured={eventbriteConfigured}
      googleConnected={googleConnected}
    />
  );
}

/**
 * What the user hid, and nothing else.
 *
 * Rendered only when there IS something hidden — an empty "Hidden" heading on everybody
 * else's page would be a permanent reminder of a feature they have not used. It exists
 * because "not mine" is otherwise a trapdoor: a mis-click on a real event would be
 * unrecoverable, and the user would have no way to know the event was ever there.
 */
async function HiddenList() {
  const hidden = await listHiddenEvents();
  if (hidden.length === 0) return null;

  return (
    <details className="rounded-xl border border-border/70 bg-card px-4 py-3">
      <summary className="cursor-pointer text-sm text-muted-foreground">
        Hidden events ({hidden.length})
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Orbit found these and you said they weren’t yours, so no sync will add them back.
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {hidden.map((event) => (
          <EventCard key={event.id} event={event} hidden />
        ))}
      </div>
    </details>
  );
}

async function EventsList() {
  const events = await listEvents();

  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          No events yet. Add one by pasting its link — the event page or your ticket, from
          Luma, Eventbrite, Partiful and the rest — and Orbit will pull in the details.
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

      {/* fallback={null} and no skeleton: this section is usually absent entirely, and a
          placeholder for something that will not appear is worse than a late arrival. */}
      <Suspense fallback={null}>
        <HiddenList />
      </Suspense>
    </div>
  );
}
