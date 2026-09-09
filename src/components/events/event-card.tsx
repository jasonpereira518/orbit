import Link from "next/link";
import { CalendarDays, MapPin, Users } from "lucide-react";
import { eventGradient } from "@/lib/events/theme";
import type { EventListRow } from "@/lib/events/store";

function formatDate(date: Date | null): string {
  if (!date) return "Date not set";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function EventCard({ event }: { event: EventListRow }) {
  const place = [event.venue, event.city].filter(Boolean).join(", ");
  return (
    <Link
      href={`/events/${event.id}`}
      className="group block overflow-hidden rounded-2xl border border-border/70 bg-card transition-shadow hover:shadow-md"
    >
      <div
        className="relative h-24 w-full"
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
          <span className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">
            Hosted
          </span>
        ) : null}
      </div>

      <div className="p-4">
        <h2 className="truncate font-medium text-ink group-hover:underline">{event.title}</h2>
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
  );
}
