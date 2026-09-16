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
 * ## Two kinds of `timezone`, and why the second one had to be taught
 *
 * A scraped page publishes an OFFSET (`-08:00`), because that is what an ISO timestamp carries.
 * Every provider API publishes an IANA ZONE NAME (`America/New_York`) instead, and so does an
 * ICS `TZID`. Until this function understood the second kind it returned null for all of them,
 * which is a silent shift of zero — so every Luma and Eventbrite event displayed and edited in
 * UTC while looking perfectly consistent about it.
 *
 * A zone name is not a fixed offset: `America/New_York` is -05:00 in January and -04:00 in
 * July. So the resolution takes the INSTANT it is being asked about. Callers that have one
 * pass it; the fallback is now, which is only ever used for a label.
 *
 * Pure: no network, no database, no DOM. `Intl` is ambient in both Node and the browser.
 */

/**
 * An IANA zone name (`America/New_York`, `UTC`) as minutes east of UTC at `at`.
 *
 * Deliberately narrow about what counts as a zone name: `Region/City`, or UTC/GMT. Node's
 * `Intl` also accepts `PST` and even `-08:00` as zone ids, which would make this function
 * silently disagree with the offset parser above about the same string and would accept
 * abbreviations that are genuinely ambiguous worldwide. Everything real — provider APIs, ICS
 * TZIDs — uses `Region/City`.
 */
function zoneNameOffsetMinutes(timezone: string, at: Date): number | null {
  if (!/^(?:[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+\-/]+|UTC|GMT)$/i.test(timezone)) return null;
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    if (!name) return null;
    // `GMT` bare means zero; otherwise `GMT-04:00`.
    if (/^GMT$/i.test(name)) return 0;
    const hit = /^GMT([+-])(\d{2}):?(\d{2})$/i.exec(name);
    if (!hit) return null;
    return (hit[1] === "-" ? -1 : 1) * (Number(hit[2]) * 60 + Number(hit[3]));
  } catch {
    // An unknown zone id throws RangeError. That is "no offset", not a crash in the hero.
    return null;
  }
}

/**
 * A published UTC offset (`-08:00`, `+0530`, `Z`) or IANA zone name (`America/New_York`) as
 * minutes east of UTC, resolved at `at` because a zone name's offset depends on the date.
 */
export function offsetMinutes(
  timezone: string | null | undefined,
  at?: Date | null
): number | null {
  if (!timezone) return null;
  if (/^z$/i.test(timezone)) return 0;
  const hit = /^([+-])(\d{2}):?(\d{2})$/.exec(timezone);
  if (!hit) {
    const when = at && !Number.isNaN(at.getTime()) ? at : new Date();
    return zoneNameOffsetMinutes(timezone.trim(), when);
  }
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
  const shifted = new Date(instant.getTime() + (offsetMinutes(timezone, instant) ?? 0) * 60_000);
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
 *
 * ## Why the offset is resolved twice
 *
 * A zone name's offset depends on the instant, and the instant is what we are solving for. The
 * first pass reads the wall clock as if it were UTC, which lands within a day of the answer —
 * close enough to pick the right side of a DST boundary for every wall clock except one within
 * the shift itself. The second pass re-resolves at that estimate and uses it. Iterating further
 * buys nothing: the only inputs that still move are the ones inside the skipped hour, which do
 * not exist on the venue's clock at all.
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
  const estimate = new Date(asUtc - (offsetMinutes(timezone, new Date(asUtc)) ?? 0) * 60_000);
  const instant = new Date(asUtc - (offsetMinutes(timezone, estimate) ?? 0) * 60_000);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** How the event's zone should be described to the user, or null when it was never stated. */
export function zoneLabel(
  timezone: string | null | undefined,
  at?: Date | null
): string | null {
  const minutes = offsetMinutes(timezone, at);
  if (minutes === null) return null;
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
