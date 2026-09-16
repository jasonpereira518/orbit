/**
 * Reading and writing an event's time in the venue's wall clock.
 *
 * The load-bearing property is the ROUND TRIP: `fromWallClockInput(toWallClockInput(t)) === t`.
 * Display and editing are inverse conversions of the same arithmetic, and if they ever drift
 * apart the failure is silent — every edit would be stored at the wrong instant and rendered
 * back wrongly in the same direction, so the screen would look correct while the database
 * held the wrong time.
 *
 * The second property is that a `datetime-local` string is never handed to `new Date()`. That
 * constructor reads a zone-less string in the RUNTIME's zone, so the same edit would land on
 * a different instant depending on where the browser was. These assertions pin exact UTC
 * instants, which is what makes them fail on a machine-dependent implementation.
 */
import {
  fromWallClockInput,
  offsetMinutes,
  toWallClockInput,
  zoneLabel,
} from "../src/lib/events/wall-clock";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function main() {
  console.log("\noffset parsing");
  check("a negative offset", offsetMinutes("-08:00") === -480, String(offsetMinutes("-08:00")));
  check("a positive half-hour offset", offsetMinutes("+05:30") === 330, String(offsetMinutes("+05:30")));
  check("the compact form", offsetMinutes("+0530") === 330, String(offsetMinutes("+0530")));
  check("Z is zero, not absent", offsetMinutes("Z") === 0, String(offsetMinutes("Z")));
  check("null stays null", offsetMinutes(null) === null);
  // A malformed offset must not silently move an event several days.
  check("an out-of-range offset is rejected", offsetMinutes("+99:99") === null, String(offsetMinutes("+99:99")));
  check("nonsense is rejected", offsetMinutes("PST") === null, String(offsetMinutes("PST")));

  console.log("\nIANA zone names, which every provider API sends");
  {
    // The bug this pins: a zone NAME used to parse as null, which is a shift of zero — so
    // every Luma and Eventbrite event displayed and edited in UTC while looking consistent.
    const summer = new Date("2026-07-04T16:00:00.000Z");
    const winter = new Date("2026-01-04T16:00:00.000Z");
    check(
      "New York in July is -04:00",
      offsetMinutes("America/New_York", summer) === -240,
      String(offsetMinutes("America/New_York", summer))
    );
    check(
      "and in January is -05:00",
      offsetMinutes("America/New_York", winter) === -300,
      String(offsetMinutes("America/New_York", winter))
    );
    check(
      "a half-hour zone",
      offsetMinutes("Asia/Kolkata", summer) === 330,
      String(offsetMinutes("Asia/Kolkata", summer))
    );
    check("UTC by name", offsetMinutes("UTC", summer) === 0, String(offsetMinutes("UTC", summer)));
    check(
      "an unknown zone is no zone, not a crash",
      offsetMinutes("Mars/Olympus_Mons", summer) === null
    );
    // Node's `Intl` accepts "PST" and even "-08:00" as zone ids. Accepting those here would
    // make this function disagree with the offset parser above about the same string, so a
    // zone name has to look like Region/City (or UTC/GMT).
    check("an abbreviation is still rejected", offsetMinutes("PST") === null);
  }

  console.log("\nreading an instant into the form");
  {
    // 2026-03-05T02:00Z is 6pm on the 4th in San Francisco. The form must say 18:00 on the
    // 4th — the time the host wrote — not 02:00 on the 5th.
    const value = toWallClockInput(new Date("2026-03-05T02:00:00.000Z"), "-08:00");
    check("shows the venue's wall clock", value === "2026-03-04T18:00", value);
  }
  {
    const value = toWallClockInput(new Date("2026-03-04T18:00:00.000Z"), null);
    check("a zone-less event shows its literal time", value === "2026-03-04T18:00", value);
  }
  check("a missing date is an empty field", toWallClockInput(null, "-08:00") === "");

  console.log("\nwriting the form back to an instant");
  {
    // The bug this guards: `new Date("2026-03-04T18:00")` would apply the RUNTIME's zone.
    const instant = fromWallClockInput("2026-03-04T18:00", "-08:00");
    check(
      "6pm in a -08:00 venue is 02:00Z the next day",
      instant?.toISOString() === "2026-03-05T02:00:00.000Z",
      String(instant?.toISOString())
    );
  }
  {
    const instant = fromWallClockInput("2026-03-04T18:00", null);
    check(
      "with no zone it is stored as written",
      instant?.toISOString() === "2026-03-04T18:00:00.000Z",
      String(instant?.toISOString())
    );
  }
  check("an empty field is no date", fromWallClockInput("", "-08:00") === null);
  check("junk is no date", fromWallClockInput("not a date", null) === null);

  console.log("\nediting an event in a named zone");
  {
    // 7pm on the 4th of July in New York is 23:00Z — the summer offset, not the winter one.
    const instant = fromWallClockInput("2026-07-04T19:00", "America/New_York");
    check(
      "summer uses the DST offset",
      instant?.toISOString() === "2026-07-04T23:00:00.000Z",
      String(instant?.toISOString())
    );
  }
  {
    const instant = fromWallClockInput("2026-01-04T19:00", "America/New_York");
    check(
      "winter uses the standard offset",
      instant?.toISOString() === "2026-01-05T00:00:00.000Z",
      String(instant?.toISOString())
    );
  }

  console.log("\nthe round trip is the identity");
  for (const zone of [
    "-08:00",
    "+05:30",
    "Z",
    null,
    // Both sides of a clock change, where a single-pass offset lookup would land an hour out.
    "America/New_York",
    "Australia/Sydney",
  ]) {
    for (const iso of [
      "2026-03-05T02:00:00.000Z",
      "2026-12-31T23:59:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-07-04T12:30:00.000Z",
    ]) {
      const original = new Date(iso);
      const back = fromWallClockInput(toWallClockInput(original, zone), zone);
      check(
        `${iso} @ ${zone ?? "no zone"}`,
        back?.toISOString() === iso,
        String(back?.toISOString())
      );
    }
  }

  console.log("\nzone labels");
  check("negative", zoneLabel("-08:00") === "UTC-08:00", String(zoneLabel("-08:00")));
  check("half-hour", zoneLabel("+05:30") === "UTC+05:30", String(zoneLabel("+05:30")));
  check("zero reads as UTC", zoneLabel("Z") === "UTC", String(zoneLabel("Z")));
  check("unstated has no label", zoneLabel(null) === null);

  console.log(
    failures === 0 ? "\nAll wall-clock checks passed\n" : `\n${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
