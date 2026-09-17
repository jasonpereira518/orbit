/**
 * Comparing an event against its page, so a refresh can be confirmed before it happens.
 *
 * Enrichment only ever fills blanks — `existing ?? fetched` — which is right the first time
 * and useless later: once a field has a value, nothing can update it. A refresh button built
 * on that rule would appear to do something and do nothing.
 *
 * So resync REPLACES. That makes it destructive, which is why it is a two-step: this module
 * produces the diff, the user confirms it, and only then does anything get written. It is the
 * same shape as `previewConnect` → `connectAttendees`, for the same reason — the irreversible
 * half needs a human in front of it.
 *
 * ## Absence is not a statement
 *
 * The one thing replacement does NOT do is clear a field because the page stopped mentioning
 * it. A host reshuffling their markup, or a parse that misses one tag, would otherwise wipe
 * the venue off every event that page produced. So a null from the parser means "no news",
 * never "it's gone", and `resolveField` below encodes exactly that: a fetched value wins when
 * it exists, and the stored value survives when it does not.
 *
 * The diff is therefore also the complete list of what a resync can change — if a field is
 * not listed, confirming will not touch it.
 *
 * Pure: no network, no database. `smoke-event-resync.ts` runs it in the `pure` tier.
 */
import { toWallClockInput } from "@/lib/events/wall-clock";
import type { EventPageDetails } from "@/lib/events/parse-page";
import type { EventRecord } from "@/db/schema";

export type EventFieldChange = {
  /** Machine key, matching the column it will be written to. */
  field: string;
  /** How to name it to a human. */
  label: string;
  from: string | null;
  to: string;
};

/** Replace-mode resolution: the page wins when it has something, otherwise nothing changes. */
export function resolveField<T>(fetched: T | null | undefined, current: T | null): T | null {
  return fetched ?? current;
}

const ATTENDANCE_TEXT: Record<string, string> = {
  offline: "In person",
  online: "Online",
  mixed: "Hybrid",
};

/** `2026-03-04 18:00` in the event's own zone — the same wall clock the hero shows. */
function showInstant(instant: Date | null, timezone: string | null): string | null {
  const value = toWallClockInput(instant, timezone);
  return value ? value.replace("T", " ") : null;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** A description can be long; a diff row is not the place to print all of it. */
function shorten(value: string | null, max = 120): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

/**
 * What a resync would change, in the order it should be read.
 *
 * Only differences are returned, and only where the page actually published something — see
 * the header. An empty array means the page still says exactly what we already hold, which
 * the UI should report as "nothing to update" rather than as a failure.
 */
export function diffEventAgainstPage(
  event: EventRecord,
  details: EventPageDetails
): EventFieldChange[] {
  const changes: EventFieldChange[] = [];

  // The zone the NEW times should be read in: the page's if it published one, else the
  // event's existing zone. Formatting the two sides in different zones would invent a
  // difference where there is none.
  const zone = details.timezone ?? event.timezone;

  const add = (field: string, label: string, from: string | null, to: string | null) => {
    if (to === null) return; // no news
    if ((from ?? "") === to) return;
    changes.push({ field, label, from, to });
  };

  add("title", "Title", trimmed(event.title), trimmed(details.title));
  add("startsAt", "Starts", showInstant(event.startsAt, event.timezone), showInstant(details.startsAt, zone));
  add("endsAt", "Ends", showInstant(event.endsAt, event.timezone), showInstant(details.endsAt, zone));
  add("venue", "Venue", trimmed(event.venue), trimmed(details.venue));
  add("city", "City", trimmed(event.city), trimmed(details.city));
  add("organizerName", "Host", trimmed(event.organizerName), trimmed(details.organizerName));
  add("organizerUrl", "Host link", trimmed(event.organizerUrl), trimmed(details.organizerUrl));
  add(
    "attendanceMode",
    "Format",
    event.attendanceMode ? ATTENDANCE_TEXT[event.attendanceMode] ?? event.attendanceMode : null,
    details.attendanceMode ? ATTENDANCE_TEXT[details.attendanceMode] ?? details.attendanceMode : null
  );
  add(
    "description",
    "Description",
    shorten(trimmed(event.description)),
    shorten(trimmed(details.description))
  );

  // Reported as one line rather than a URL diff nobody can read. `cover_source_url` holds
  // what the page last offered, so comparing against it detects a genuinely new graphic.
  if (details.imageUrl && details.imageUrl !== event.coverSourceUrl) {
    changes.push({
      field: "coverImageUrl",
      label: "Cover art",
      from: event.coverImageUrl ? "current image" : null,
      to: "a new image from the page",
    });
  }

  // Only when the user has not chosen their own — a locked theme is never overwritten, so
  // promising a change here would be a lie.
  if (
    event.themeLocked !== 1 &&
    details.themeColor &&
    details.themeColor.toLowerCase() !== (event.themeColor ?? "").toLowerCase()
  ) {
    changes.push({
      field: "themeColor",
      label: "Accent colour",
      from: event.themeColor,
      to: details.themeColor,
    });
  }

  // Speakers are additive and never removed, so this is a count, not a replacement.
  if (details.speakers.length > 0) {
    changes.push({
      field: "speakers",
      label: "Speakers",
      from: null,
      to:
        details.speakers.length === 1
          ? "1 name on the page will be added to the roster if missing"
          : `${details.speakers.length} names on the page will be added to the roster if missing`,
    });
  }

  return changes;
}
