/**
 * The themed hero.
 *
 * `eventThemeVars` ships BOTH themes' values inline and the `.event-theme` rules in
 * globals.css pick between them. An inline style cannot be theme-conditional, and next-themes
 * can flip `.dark` after render with no round trip — so choosing in CSS is what keeps the
 * swap free and flash-free.
 *
 * Every accent arriving here is already contrast-clamped; there is no unclamped path out of
 * `theme.ts`, so nothing below re-checks legibility.
 */
import { CalendarDays, ExternalLink, MapPin, Users, Video } from "lucide-react";
import { eventGradient, eventThemeVars } from "@/lib/events/theme";
import { offsetMinutes } from "@/lib/events/wall-clock";
import { CoverPaletteProbe } from "./cover-palette-probe";
import { EventActions } from "./event-actions";
import type { EventRecord } from "@/db/schema";

/**
 * The event's date, in the VENUE's wall clock rather than the server's.
 *
 * This component renders on the server, so a bare `toLocaleTimeString()` formats in the
 * runtime's zone — UTC on Vercel. A 6pm event in San Francisco was being shown as 2am the
 * next day. `parse-page.ts` stores every instant as UTC and records the offset the host
 * published, so shifting by that offset and formatting in UTC reproduces exactly the time
 * the host wrote. When no offset was published the instant already IS the host's wall clock
 * (see `parseDate`), so formatting in UTC is right for that case too — which is why there is
 * no branch here, only a shift of zero.
 *
 * Passing the offset to `Intl` as a `timeZone` would be the obvious alternative; offset
 * strings are not portable across runtimes there. A provider API DOES give us an IANA name,
 * and `offsetMinutes` now resolves one — at the event's own instant, so a summer event in
 * `America/New_York` shifts by -04:00 and a winter one by -05:00.
 *
 * `offsetMinutes` is imported rather than kept here because the edit dialog has to run this
 * conversion BACKWARDS. Two copies would drift, and a drift between the reader and the
 * writer is invisible: every edit would be stored at the wrong instant and rendered back
 * wrongly in the same direction, so the screen would look right.
 */
function formatRange(startsAt: Date | null, endsAt: Date | null, timezone: string | null): string {
  if (!startsAt) return "Date not set";
  // Resolved per instant rather than once, so a conference spanning a clock change reads
  // correctly on both of its days.
  const at = (d: Date) => new Date(d.getTime() + (offsetMinutes(timezone, d) ?? 0) * 60_000);

  const start = at(startsAt);
  const date = start.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

  if (!endsAt || endsAt.getTime() <= startsAt.getTime()) return `${date} · ${time(start)}`;

  const end = at(endsAt);
  const sameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  if (sameDay) return `${date} · ${time(start)} – ${time(end)}`;
  const endDate = end.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${date} · ${time(start)} – ${endDate}, ${time(end)}`;
}

const ATTENDANCE_LABEL = { online: "Online", mixed: "Hybrid" } as const;

export function EventHero({ event }: { event: EventRecord }) {
  const accent = event.themeColor ?? "#6b7280";
  const place = [event.venue, event.city].filter(Boolean).join(", ");

  return (
    <div
      className="event-theme reveal-mount overflow-hidden rounded-2xl border border-border/70"
      style={eventThemeVars(accent) as React.CSSProperties}
    >
      <div
        className="relative flex min-h-44 items-end"
        style={
          event.coverImageUrl ? undefined : { backgroundImage: eventGradient(accent) }
        }
      >
        {event.coverImageUrl ? (
          <>
            {/* Covers are arbitrary remote or Blob URLs, which next/image's loader config
                cannot enumerate, so a plain <img> is correct here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={event.coverImageUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
            {/* Guarantees the bottom third is dark enough for the title regardless of what
                the host chose as their graphic. */}
            <div className="event-hero-scrim absolute inset-0" aria-hidden />
          </>
        ) : null}

        <div className="relative w-full p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
              {event.role === "hosted" ? "You hosted this" : "You attended"}
            </span>
            {/* Only when it is not the assumed case: badging every in-person event "In person"
                would be noise on the majority and would not make the minority stand out. */}
            {event.attendanceMode === "online" || event.attendanceMode === "mixed" ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                <Video className="size-3" aria-hidden />
                {ATTENDANCE_LABEL[event.attendanceMode]}
              </span>
            ) : null}
          </div>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-white drop-shadow-sm">
            {event.title}
          </h1>
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 text-sm"
        style={{ background: "var(--event-tint)" }}
      >
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <CalendarDays className="size-4" style={{ color: "var(--event-accent)" }} aria-hidden />
          {formatRange(event.startsAt, event.endsAt, event.timezone)}
          {/* The host published a wall-clock time with no zone, so the time above is their
              text taken at face value. Said plainly rather than shown as false precision. */}
          {event.startsAt && !event.timezone ? (
            <span className="text-xs opacity-70" title="The event page did not say which time zone this is in.">
              (time zone not stated)
            </span>
          ) : null}
        </span>
        {event.organizerName ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Users className="size-4" style={{ color: "var(--event-accent)" }} aria-hidden />
            {event.organizerUrl ? (
              <a
                href={event.organizerUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline-offset-2 hover:underline"
              >
                {event.organizerName}
              </a>
            ) : (
              event.organizerName
            )}
          </span>
        ) : null}
        {place ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="size-4" style={{ color: "var(--event-accent)" }} aria-hidden />
            {place}
          </span>
        ) : null}
        {event.url ? (
          <a
            href={event.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 underline-offset-2 hover:underline"
            style={{ color: "var(--event-accent)" }}
          >
            <ExternalLink className="size-4" aria-hidden />
            Event page
          </a>
        ) : null}

        {/* Pushed to the end of the strip so the details read first and the controls sit
            where the eye lands last. */}
        <div className="ml-auto">
          <EventActions
            event={{
              id: event.id,
              title: event.title,
              description: event.description,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              timezone: event.timezone,
              venue: event.venue,
              city: event.city,
              url: event.url,
              organizerName: event.organizerName,
              organizerUrl: event.organizerUrl,
              attendanceMode: event.attendanceMode,
            }}
          />
        </div>
      </div>

      {event.description ? (
        <p className="border-t border-border/70 px-5 py-3 text-sm leading-relaxed text-muted-foreground">
          {event.description}
        </p>
      ) : null}

      {/* Only mounts when there is a cover and no user-chosen colour — see the component. */}
      <CoverPaletteProbe
        eventId={event.id}
        coverUrl={event.coverImageUrl}
        themeSource={event.themeSource}
        themeLocked={event.themeLocked === 1}
      />
    </div>
  );
}
