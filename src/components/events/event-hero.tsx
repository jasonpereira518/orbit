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
import { CalendarDays, ExternalLink, MapPin } from "lucide-react";
import { eventGradient, eventThemeVars } from "@/lib/events/theme";
import { CoverPaletteProbe } from "./cover-palette-probe";
import type { EventRecord } from "@/db/schema";

function formatRange(startsAt: Date | null, endsAt: Date | null): string {
  if (!startsAt) return "Date not set";
  const date = startsAt.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = startsAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return endsAt && endsAt.getTime() !== startsAt.getTime() ? `${date} · ${time}` : `${date} · ${time}`;
}

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
          {formatRange(event.startsAt, event.endsAt)}
        </span>
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
      </div>

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
