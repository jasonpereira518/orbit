import { Suspense } from "react";
import { notFound } from "next/navigation";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { ArrowLeft } from "lucide-react";
import { IntentLink } from "@/components/ui/intent-link";
import { PageShell } from "@/components/layout/page-shell";
import { PageSection } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EventHero } from "@/components/events/event-hero";
import { AttendeeRoster, type RosterMatch } from "@/components/events/attendee-roster";
import { RosterImportPanel } from "@/components/events/roster-import-panel";
import { EventCompaniesPanel } from "@/components/events/event-companies-panel";
import { WhoToTalkToCard } from "@/components/events/who-to-talk-to-card";
import {
  getEvent,
  getEventCompanies,
  getRoster,
  getWhoToTalkTo,
  getRosterHistory,
  matchRosterToNetwork,
} from "@/actions/events";
import { RenderStamp } from "@/components/layout/render-stamp";

async function WhoToTalkTo({ eventId }: { eventId: string }) {
  const data = await getWhoToTalkTo(eventId);
  if (!data) return null;
  return <WhoToTalkToCard eventId={eventId} data={data} aiAvailable={data.aiAvailable} />;
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

  // A failed read used to fall through to the roster's "No attendees yet" empty state, which
  // told the user their guest list was empty when in fact it could not be loaded. Those are
  // opposite facts and must not share a screen.
  if (!result.ok) {
    return (
      <Card size="sm">
        <CardContent className="text-sm text-muted-foreground">
          The guest list couldn’t be loaded just now. Refresh to try again — nothing has been
          lost.
        </CardContent>
      </Card>
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

  // The history is an aggregate over the user's whole roster past; a failure there costs a
  // badge, never the list, so it degrades to "we did not say" exactly as matches do.
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
  // See `pageVisibilityGate`'s doc comment: the layout-level check does not catch a click
  // straight from a sibling route, so this page re-checks itself.
  const gate = await pageVisibilityGate("page.events");
  if (gate) return gate;

  const { id } = await params;

  // Both started before the first await and settled to a value, so they are already in flight
  // while the event row loads and an eager rejection cannot go unhandled.
  //
  // The roster's failure is kept as a distinct state rather than collapsed to `[]`; the match
  // lookup's is not, because a missing badge degrades to "we did not say", which is honest.
  const rosterPromise: Promise<RosterResult> = getRoster(id).then(
    (rows) => ({ ok: true as const, rows }),
    () => ({ ok: false as const })
  );
  const matchesPromise = matchRosterToNetwork(id).catch(() => []);
  const historyPromise = getRosterHistory(id).catch(() => []);

  const event = await getEvent(id);
  // Before any Suspense boundary, so the route returns a real 404 rather than streaming a
  // shell and then discovering there is nothing to put in it.
  if (!event) notFound();

  return (
    <PageShell width="wide" spacing="tight">
      <RenderStamp />
      {/* A static destination rather than `router.back()`: an event page is a deep link
          people reach from a fresh tab or a search result, where going back leaves the app.
          The hero is this page's h1, so the back link stands alone in `PageHeader`'s style
          rather than inside a second header. */}
      <IntentLink
        href="/events"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to events
      </IntentLink>

      <EventHero event={event} />

      {event.enrichError ? (
        <Card size="sm">
          <CardContent className="text-sm text-muted-foreground">
            Orbit couldn’t read that event page: {event.enrichError}
          </CardContent>
        </Card>
      ) : null}

      <div className="reveal-mount" style={{ "--reveal-delay": "60ms" } as React.CSSProperties}>
        <RosterImportPanel eventId={event.id} />
      </div>

      {/* The shortlist first: it is the answer, and the roster below it is the evidence.
          `fallback={null}` because it renders nothing when the facts single nobody out. */}
      <div className="reveal-mount" style={{ "--reveal-delay": "70ms" } as React.CSSProperties}>
        <Suspense fallback={null}>
          <WhoToTalkTo eventId={event.id} />
        </Suspense>
      </div>

      {/* Companies before the roster: at a career fair the booth list IS the event, and at a
          conference it is the shape that makes four hundred names navigable. */}
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
          <Companies eventId={event.id} />
        </Suspense>
      </div>

      <div className="reveal-mount" style={{ "--reveal-delay": "120ms" } as React.CSSProperties}>
        <PageSection title="Who was there">
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
            <Roster
              eventId={event.id}
              rosterPromise={rosterPromise}
              matchesPromise={matchesPromise}
              historyPromise={historyPromise}
            />
          </Suspense>
        </PageSection>
      </div>
    </PageShell>
  );
}
