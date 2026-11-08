import Link from "next/link";
import { CalendarDays, FileText, MapPin, Sparkles, Users } from "lucide-react";
import { eventGradient, eventThemeVars } from "@/lib/events/theme";
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
  const accent = event.themeColor ?? "#6b7280";
  const place = [event.venue, event.city].filter(Boolean).join(", ");
  const found = event.discoveredVia ? DISCOVERY_LABEL[event.discoveredVia] : null;
  const rsvp = event.rsvpStatus ? RSVP_LABEL[event.rsvpStatus] : null;
  const themeVars = eventThemeVars(accent);

  return (
    <div className="relative">
      <Link
        href={`/events/${event.id}`}
        className="event-theme group block overflow-hidden rounded-2xl border border-border/70 bg-card transition-all duration-200 hover:border-[var(--event-accent)] hover:shadow-lg"
        style={themeVars as React.CSSProperties}
      >
        <div
          className="relative aspect-[5/2] w-full overflow-hidden bg-muted"
          style={
            event.coverImageUrl
              ? undefined
              : { backgroundImage: eventGradient(accent) }
          }
        >
          {event.coverImageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={event.coverImageUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              loading="lazy"
            />
          ) : null}

          {/* Role badge */}
          {event.role === "hosted" ? (
            <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2 py-0.5 text-2xs font-medium text-white backdrop-blur-sm">
              Hosted
            </span>
          ) : null}
        </div>

        <div className="p-4">
          <h2 className="truncate font-medium text-ink transition-colors group-hover:text-[var(--event-accent)]">
            {event.title}
          </h2>

          {found || rsvp ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {found ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--event-tint)] px-2 py-0.5 text-2xs text-[var(--event-accent)]">
                  <Sparkles className="size-3" aria-hidden />
                  {found}
                </span>
              ) : null}
              {rsvp ? (
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-2xs text-muted-foreground">
                  {rsvp}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="size-3.5 shrink-0" aria-hidden />
              {formatDate(event.startsAt)}
            </span>
            {place ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate max-w-[180px]">{place}</span>
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-3.5 shrink-0" aria-hidden />
              {/* Both numbers, always: "12 people" hides whether any became contacts. */}
              {event.connectedCount} of {event.attendeeCount} connected
            </span>
          </div>
        </div>
      </Link>

      {hidden ? <DismissEventButton eventId={event.id} title={event.title} hidden /> : null}
    </div>
  );
}
