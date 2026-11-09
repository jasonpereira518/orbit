/**
 * "Now" on the user's clock, whatever zone the server runs in. No DB, no network.
 *
 * The case every check pins: 10:30pm Sunday in New York is already Monday in UTC. A prompt,
 * a "tomorrow", a daily cap or a Radar label built on the server's day gets it a day wrong.
 *
 * Run: npx tsx scripts/smoke-user-clock.ts   (also under TZ=Asia/Tokyo: same answers)
 */
import { promptNow, startOfUserDay, userDayAnchor, weekdayInZone } from "../src/lib/user-clock";
import { resolveRelativeDate } from "../src/lib/relative-date";
import { isoDay } from "../src/lib/dates";
import { understandQuery } from "../src/lib/chat-retrieval";
import { NO_SUPPRESSION, scoreContactKinds, type RadarContact } from "../src/lib/radar/score";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const NY = "America/New_York";
// Sunday Nov 8, 10:30pm EST = Monday Nov 9, 03:30 UTC.
const NOW = new Date("2026-11-09T03:30:00Z");

async function main() {
  const line = promptNow(NY, NOW);
  check("the prompt line names the user's day", line.includes("Sunday, November 8, 2026 (2026-11-08)"), line);
  check("and their clock and zone", line.includes("10:30 PM") && line.includes(NY), line);
  check("date-only drops the clock", !promptNow(NY, NOW, { time: false }).includes("PM"));
  check("UTC would have said Monday", promptNow("UTC", NOW).includes("Monday"));
  check("weekdayInZone", weekdayInZone(NOW, NY) === "Sunday");

  const anchor = userDayAnchor(NY, NOW);
  check("the anchor is the user's day on this runtime's calendar", isoDay(anchor) === "2026-11-08", isoDay(anchor));
  check("and its weekday", anchor.getDay() === 0, String(anchor.getDay()));
  const tomorrow = resolveRelativeDate("tomorrow", anchor);
  check("\"tomorrow\" is the user's tomorrow", !!tomorrow && isoDay(tomorrow.date) === "2026-11-09", tomorrow ? isoDay(tomorrow.date) : "null");
  const friday = resolveRelativeDate("next friday", anchor);
  check("\"next friday\" counts from Sunday", !!friday && isoDay(friday.date).startsWith("2026-11-1"), friday ? isoDay(friday.date) : "null");

  check("the user's day began at their midnight", startOfUserDay(NY, NOW).toISOString() === "2026-11-08T05:00:00.000Z", startOfUserDay(NY, NOW).toISOString());

  // chat.understand is told the user's date, not UTC's.
  let seen = "";
  const stub = (async (_u: string, opts: { user: string }) => {
    seen = opts.user;
    return JSON.stringify({ semanticQuery: "x", filters: {} });
  }) as never;
  await understandQuery("u1", "what's on tomorrow?", [], stub, { timeZone: NY });
  const today = promptNow(NY, new Date(), { time: false });
  check("chat.understand gets the user's date line", seen.includes(today), seen.slice(0, 120));

  // Radar: a 9am meeting tomorrow, seen the night before, is "tomorrow" — not "today".
  const contact: RadarContact = {
    id: "c1",
    company: "Acme",
    tier: "mid",
    priorityLevel: 0,
    relationshipScore: 2,
    statedCloseness: null,
    firstInteractionAt: new Date("2025-01-01T12:00:00Z"),
    lastInteractionAt: new Date("2026-10-01T12:00:00Z"),
    nextFollowUpAt: null,
  } as RadarContact;
  const meeting = new Date("2026-11-09T14:00:00Z"); // 9am EST Monday, 10.5h after NOW
  const kinds = scoreContactKinds(contact, [{ kind: "upcoming_meeting", contactId: "c1", at: meeting, title: null }], NO_SUPPRESSION, NOW, null, NY);
  const label = kinds.flatMap((k) => k.reasons).find((r) => r.code === "upcoming_meeting")?.label ?? "";
  check("Radar says tomorrow on the user's calendar", label.endsWith("tomorrow"), label);
}

main().then(() => {
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll user clock checks passed.");
  process.exit(0);
});
