import { Suspense } from "react";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { EventsHeader } from "@/components/events/events-header";
import { EventCard } from "@/components/events/event-card";
import { AddEventDialog } from "@/components/events/add-event-dialog";
import { EventConnectionsCard } from "@/components/events/event-connections-card";
import { EventsTabs } from "@/components/events/events-tabs";
import { RecommendedEventsTab } from "@/components/events/recommended-events-tab";
import { RepeatPeoplePanel } from "@/components/events/repeat-people-panel";
import { EventsListSkeleton } from "@/components/loading/page-skeletons";
import type { EventListRow } from "@/lib/events/store";
import {
  getEventConnections,
  getRecommendedEvents,
  getRepeatCoAttendees,
  listEventsByTab,
  listHiddenEvents,
} from "@/actions/events";
import { RenderStamp } from "@/components/layout/render-stamp";
import { Calendar, CheckCircle2, Sparkles, Users } from "lucide-react";

export const metadata = { title: "Events" };

async function ConnectionsSection() {
  const { connections, eventbriteConfigured, calendarConnected } = await getEventConnections();
  return (
    <EventConnectionsCard
      connections={connections}
      eventbriteConfigured={eventbriteConfigured}
      calendarConnected={calendarConnected}
    />
  );
}

async function RepeatPeopleSection() {
  const people = await getRepeatCoAttendees({ limit: 8 });
  return <RepeatPeoplePanel people={people} />;
}

/**
 * What the user hid, and nothing else.
 *
 * Rendered only when there IS something hidden — an empty "Hidden" heading on everybody
 * else's page would be a permanent reminder of a feature they have not used. It exists
 * because a hidden event is otherwise a trapdoor: a mis-click on a real event would be
 * unrecoverable, and the user would have no way to know the event was ever there. Nothing
 * hides events from the card any more — discovery now only adds the ones the user went to —
 * but everything hidden before that is still here, one click from restored.
 */
async function HiddenList() {
  const hidden = await listHiddenEvents();
  if (hidden.length === 0) return null;

  return (
    <details className="rounded-xl border border-border/70 bg-card px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-ink">
        Hidden &amp; Filtered Events ({hidden.length})
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        Non-professional parties and events you’ve hidden are kept here. Click &ldquo;Add back&rdquo; on any card to restore it to your schedule.
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {hidden.map((event) => (
          <EventCard key={event.id} event={event} hidden />
        ))}
      </div>
    </details>
  );
}

function EventGrid({
  events,
  empty,
  past = false,
}: {
  events: EventListRow[];
  empty: React.ReactNode;
  past?: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {events.map((event) => (
        <EventCard key={event.id} event={event} past={past} />
      ))}
    </div>
  );
}

async function EventsList() {
  const [{ upcoming, past }, recommended] = await Promise.all([
    listEventsByTab(),
    getRecommendedEvents().catch(() => []),
  ]);

  if (upcoming.length === 0 && past.length === 0 && recommended.length === 0) {
    return (
      <EventGrid
        events={[]}
        empty={
          <>
            No events yet. Events on your calendar show up here on their own — or add one by
            name or link, and log who you met there.
          </>
        }
      />
    );
  }

  return (
    <EventsTabs
      upcomingCount={upcoming.length}
      pastCount={past.length}
      recommendedCount={recommended.length}
      upcoming={
        <EventGrid
          events={upcoming}
          empty={
            <>
              Nothing coming up yet. Add an event by link, or check the{" "}
              <strong>Recommended For You</strong> tab to find upcoming events matching your
              history.
            </>
          }
        />
      }
      past={<EventGrid events={past} empty="No past events yet." past />}
      recommended={<RecommendedEventsTab recommendations={recommended} />}
    />
  );
}

export default async function EventsPage() {
  // See `pageVisibilityGate`'s doc comment: the layout-level check does not catch a click
  // straight from a sibling route, so this page re-checks itself.
  const gate = await pageVisibilityGate("page.events");
  if (gate) return gate;

  const [{ upcoming, past }] = await Promise.all([
    listEventsByTab().catch(() => ({ upcoming: [], past: [] })),
  ]);

  const totalMet = past.reduce((acc, ev) => acc + (ev.attendeeCount ?? 0), 0);
  const totalConnected = past.reduce((acc, ev) => acc + (ev.connectedCount ?? 0), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      <RenderStamp />

      {/* Header & Primary Actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <EventsHeader />
        <div className="flex flex-wrap items-center gap-2">
          <AddEventDialog />
        </div>
      </div>

      {/* Stats Summary Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border/70 bg-card p-3 shadow-2xs">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="size-3.5 text-primary" aria-hidden />
            <span>Events Tracked</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-ink">
            {past.length + upcoming.length}
          </p>
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-3 shadow-2xs">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Users className="size-3.5 text-indigo-500" aria-hidden />
            <span>People In Rooms</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-ink">{totalMet}</p>
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-3 shadow-2xs">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden />
            <span>Network Added</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-ink">{totalConnected}</p>
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-3 shadow-2xs">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-amber-500" aria-hidden />
            <span>Upcoming RSVPs</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-ink">{upcoming.length}</p>
        </div>
      </div>

      {/* Above the list: the point of keeping rosters is the pattern across them, and a
          panel below four screens of events is a panel nobody reads. `fallback={null}`
          because it renders nothing at all until there IS a pattern. */}
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <Suspense fallback={null}>
          <RepeatPeopleSection />
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

      {/* Last: where events come from is one line (is a calendar connected?) and everything
          optional is collapsed under More sources, which still says when a connection needs
          attention. fallback={null} because a skeleton for one line is more noise than it. */}
      <Suspense fallback={null}>
        <ConnectionsSection />
      </Suspense>
    </div>
  );
}
