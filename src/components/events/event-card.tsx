import Link from "next/link";
import { CalendarDays, MapPin, Sparkles, Users } from "lucide-react";
import { eventGradient } from "@/lib/events/theme";
import { DISCOVERY_LABEL, RSVP_LABEL } from "@/components/events/event-provenance";
import { DismissEventButton } from "@/components/events/dismiss-event-button";
import type { EventListRow } from "@/lib/events/store";

function formatDate(date: Date | null): string {
  if (!date) return "Date not set";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function EventCard({
  event,
  hidden = false,
}: {
  event: EventListRow;
  hidden?: boolean;
}) {
  const place = [event.venue, event.city].filter(Boolean).join(", ");
  const found = event.discoveredVia ? DISCOVERY_LABEL[event.discoveredVia] : null;
  const rsvp = event.rsvpStatus ? RSVP_LABEL[event.rsvpStatus] : null;
  return (
    // `relative` so the dismiss control can sit above the link rather than inside it: a
    // button nested in an anchor is not clickable without fighting the anchor for the event.
    <div className="relative">
    <Link
      href={`/events/${event.id}`}
      className="group block overflow-hidden rounded-2xl border border-border/70 bg-card transition-shadow hover:shadow-md"
    >
      <div
        // 5:2 rather than a fixed 96px strip: platform covers are mostly square (Luma's
        // always are), and a strip showed the middle sixth of one — half a word of its title.
        className="relative aspect-[5/2] w-full"
        // Every event has a theme colour from creation (the hash rung guarantees it), so a
        // card is never a grey rectangle waiting on enrichment.
        style={
          event.coverImageUrl
            ? undefined
            : { backgroundImage: eventGradient(event.themeColor ?? "#6b7280") }
        }
      >
        {event.coverImageUrl ? (
          /* Covers are arbitrary remote or Blob URLs, which next/image's loader config
             cannot enumerate, so a plain <img> is correct here. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={event.coverImageUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : null}
        {event.role === "hosted" ? (
          <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
            Hosted
          </span>
        ) : null}
      </div>

      <div className="p-4">
        <h2 className="truncate font-medium text-ink group-hover:underline">{event.title}</h2>
        {found || rsvp ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {found ? (
              // An event nobody added has to say so, in the place people look first.
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                <Sparkles className="size-3" aria-hidden />
                {found}
              </span>
            ) : null}
            {rsvp ? (
              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                {rsvp}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="size-3.5" aria-hidden />
            {formatDate(event.startsAt)}
          </span>
          {place ? (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5" aria-hidden />
              <span className="truncate">{place}</span>
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-3.5" aria-hidden />
            {/* Both numbers, always: "12 people" hides whether any became contacts. */}
            {event.connectedCount} of {event.attendeeCount} connected
          </span>
        </div>
      </div>
    </Link>
      {/* Restore only, and only in the hidden list. There is no "not mine" on a live card any
          more: discovery adds only events the user is going to, and a hide control on every
          one of them read as "I'm not the host" — which is true of nearly all of them. An
          event that really is wrong has Delete on its own page. */}
      {hidden ? <DismissEventButton eventId={event.id} title={event.title} hidden /> : null}
    </div>
  );
}
