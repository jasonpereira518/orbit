/**
 * Reading and writing an event's time in the VENUE's wall clock.
 *
 * ## The bug this module exists to prevent
 *
 * An event page publishes a wall-clock time and, if you are lucky, the offset it was written
 * in. `parse-page.ts` stores the instant and records that offset, and the hero renders it back
 * by shifting into the offset and formatting in UTC — so a 6pm event in San Francisco reads
 * as 6pm however the server is configured.
 *
 * The moment that time becomes EDITABLE, the same conversion has to run backwards. A
 * `datetime-local` input hands back a naive `2026-03-04T18:00` with no zone at all. Reading
 * it with `new Date(value)` interprets it in the RUNTIME's zone, so every edit made in a
 * browser in New York would be stored five hours off — and the shift would be invisible,
 * because the hero would then render the wrong instant perfectly consistently.
 *
 * So display and editing must not each carry their own copy of the arithmetic. Both sides
 * live here: `toWallClockInput` for the form, `fromWallClockInput` for the save, and
 * `offsetMinutes` shared with the hero's formatter. A round-trip through the pair is the
 * identity, which is what `smoke-event-wall-clock.ts` pins.
 *
 * ## When no offset was published
 *
 * `timezone` is null for a host that wrote a floating local time. `parseDate` treats that as
 * UTC so the parse is deterministic rather than machine-dependent, and everything here does
 * the same — a shift of zero. The time shown is then the host's literal text, which is the
 * only honest reading available, and the UI says the zone was not stated.
 *
 * Pure: no network, no database, no DOM.
 */

/** A published UTC offset (`-08:00`, `+0530`, `Z`) as minutes east of UTC. */
export function offsetMinutes(timezone: string | null | undefined): number | null {
  if (!timezone) return null;
  if (/^z$/i.test(timezone)) return 0;
  const hit = /^([+-])(\d{2}):?(\d{2})$/.exec(timezone);
  if (!hit) return null;
  const minutes = Number(hit[2]) * 60 + Number(hit[3]);
  // A malformed offset is no offset. `+99:99` should not silently move an event four days.
  if (minutes > 14 * 60) return null;
  return (hit[1] === "-" ? -1 : 1) * minutes;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * An instant as the `YYYY-MM-DDTHH:mm` a `datetime-local` input expects, in the event's own
 * zone. Returns "" for a missing date, which is what an empty input holds.
 */
export function toWallClockInput(
  instant: Date | null | undefined,
  timezone: string | null | undefined
): string {
  if (!instant || Number.isNaN(instant.getTime())) return "";
  const shifted = new Date(instant.getTime() + (offsetMinutes(timezone) ?? 0) * 60_000);
  // Read back in UTC, because the shift above put the venue's wall clock into UTC's fields.
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/**
 * The inverse: a `datetime-local` value read as the venue's wall clock, back to an instant.
 *
 * Parsed by hand rather than with `new Date(value)` precisely because that constructor is the
 * bug — it would apply the browser's zone to a string that has none.
 */
export function fromWallClockInput(
  value: string,
  timezone: string | null | undefined
): Date | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!hit) return null;
  const [, y, mo, d, h, mi] = hit.map(Number) as unknown as number[];
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  if (Number.isNaN(asUtc)) return null;
  const instant = new Date(asUtc - (offsetMinutes(timezone) ?? 0) * 60_000);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** How the event's zone should be described to the user, or null when it was never stated. */
export function zoneLabel(timezone: string | null | undefined): string | null {
  const minutes = offsetMinutes(timezone);
  if (minutes === null) return null;
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
