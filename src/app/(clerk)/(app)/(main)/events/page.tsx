import { Suspense } from "react";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { EventsHeader } from "@/components/events/events-header";
import { EventCard } from "@/components/events/event-card";
import { AddEventDialog } from "@/components/events/add-event-dialog";
import { PlatformIntegrationsHub } from "@/components/events/platform-integrations-hub";
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
import { Calendar, CheckCircle2, Link2, Sparkles, Users } from "lucide-react";

export const metadata = { title: "Events" };

async function ConnectionsSection() {
  const {
    connections,
    eventbriteConfigured,
    googleConnected,
    googleMailGranted,
    googleCalendarGranted,
  } = await getEventConnections();

  const connectedCount = connections.filter((c) => c.status === "active").length;

  return (
    <details className="group rounded-2xl border border-border/70 bg-card p-4 transition-all">
      <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-ink">
        <div className="flex items-center gap-2">
          <Link2 className="size-4 text-primary" aria-hidden />
          <span>Connected Platforms (Luma, Eventbrite, Partiful, Google)</span>
          {connectedCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-3xs font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-2.5" />
              {connectedCount} connected
            </span>
          ) : (
            <span className="rounded-full bg-muted px-2 py-0.5 text-3xs text-muted-foreground">
              Not connected
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground group-open:rotate-180 transition-transform">
          ▼
        </span>
      </summary>
      <div className="mt-4 border-t border-border/60 pt-4">
        <PlatformIntegrationsHub
          connections={connections}
          eventbriteConfigured={eventbriteConfigured}
          googleConnected={googleConnected}
          googleMailGranted={googleMailGranted}
          googleCalendarGranted={googleCalendarGranted}
        />
      </div>
    </details>
  );
}

async function RepeatPeopleSection() {
  const people = await getRepeatCoAttendees({ limit: 8 });
  return <RepeatPeoplePanel people={people} />;
}

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

function EventGrid({ events, empty }: { events: EventListRow[]; empty: React.ReactNode }) {
  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {events.map((event) => (
        <EventCard key={event.id} event={event} />
      ))}
    </div>
  );
}

async function EventsList() {
  const [{ upcoming, past }, recommended] = await Promise.all([
    listEventsByTab(),
    getRecommendedEvents().catch(() => []),
  ]);

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
      past={<EventGrid events={past} empty="No past events logged yet." />}
      recommended={<RecommendedEventsTab recommendations={recommended} />}
    />
  );
}

export default async function EventsPage() {
  const gate = await pageVisibilityGate("page.events");
  if (gate) return gate;

  const [{ upcoming, past }, { connections }] = await Promise.all([
    listEventsByTab().catch(() => ({ upcoming: [], past: [] })),
    getEventConnections().catch(() => ({ connections: [] })),
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

      {/* Platform Integrations Hub */}
      <Suspense fallback={null}>
        <ConnectionsSection />
      </Suspense>

      {/* Repeat Co-Attendees Panel */}
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <Suspense fallback={null}>
          <RepeatPeopleSection />
        </Suspense>
      </div>

      {/* Tabs with Upcoming, Past, and Recommended */}
      <div className="reveal-mount" style={{ "--reveal-delay": "120ms" } as React.CSSProperties}>
        <Suspense fallback={<EventsListSkeleton />}>
          <EventsList />
        </Suspense>
      </div>

      {/* Hidden Events */}
      <Suspense fallback={null}>
        <HiddenList />
      </Suspense>
    </div>
  );
}
