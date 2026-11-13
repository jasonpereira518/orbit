/**
 * Message-format PR 3: real free times in a draft's meeting ask, and a sequence's follow-ups
 * replying in the first email's thread.
 *
 *   - `pickFreeWindows` (src/lib/calendar-free-windows.ts): business days 2 to 8, mornings and
 *     afternoons with a 30-minute gap, all-day events take the day, declined ones do not count,
 *     labels in the user's own time zone, no day repeated or skipped across a DST change.
 *   - `formatRules` offers exactly those two times when it has them, and no date otherwise.
 *   - The Resend payload carries In-Reply-To / References for a follow-up, and the compliance
 *     footer has no em dash (the house format bans them).
 *
 * No DB rows, no network. Run: npx tsx scripts/smoke-draft-times-threads.ts
 */
import { readFileSync } from "node:fs";
import { pickFreeWindows, type BusyEvent } from "../src/lib/calendar-free-windows";
import { formatRules } from "../src/lib/message-format";
import { outreachEmailPayload } from "../src/lib/outreach-email";
import { replySubject } from "../src/lib/outreach-drafts";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NY = "America/New_York";
// Friday 13 November 2026, 10:00 in New York. Business day 1 is Monday the 16th (skipped),
// so the first window can be Tuesday the 17th.
const NOW = new Date("2026-11-13T15:00:00Z");
const at = (iso: string) => new Date(iso);
const ev = (start: string, end: string, extra: Partial<BusyEvent> = {}): BusyEvent => ({ startAt: at(start), endAt: at(end), allDay: false, ...extra });
const labels = (events: BusyEvent[], tz = NY, now = NOW) => pickFreeWindows(events, now, tz).map((w) => w.label);

async function main() {
  console.log("free windows");
  const empty = labels([]);
  check("an empty calendar: Tuesday morning, then Wednesday afternoon (alternating)", JSON.stringify(empty) === JSON.stringify(["Tuesday November 17, in the morning", "Wednesday November 18, in the afternoon"]), JSON.stringify(empty));
  check("never the next business day, never a weekend", !empty.some((l) => /Monday November 16|Saturday|Sunday/.test(l)));

  // Tuesday 10:00-12:00 New York (15:00-17:00Z) fully booked.
  const busyMorning = labels([ev("2026-11-17T15:00:00Z", "2026-11-17T17:00:00Z")]);
  check("a booked morning: that day's afternoon instead", busyMorning[0] === "Tuesday November 17, in the afternoon", JSON.stringify(busyMorning));
  check("and then the other part of the day next", busyMorning[1] === "Wednesday November 18, in the morning", JSON.stringify(busyMorning));

  // Tuesday 10:00-11:40 and 11:50-12:00: only a 10-minute gap left.
  const crumbs = labels([ev("2026-11-17T15:00:00Z", "2026-11-17T16:40:00Z"), ev("2026-11-17T16:50:00Z", "2026-11-17T17:00:00Z")]);
  check("a 10-minute gap is not a free morning", crumbs[0] === "Tuesday November 17, in the afternoon", JSON.stringify(crumbs));
  // Tuesday 10:00-11:30 only: a 30-minute gap at the end.
  const tail = labels([ev("2026-11-17T15:00:00Z", "2026-11-17T16:30:00Z")]);
  check("a 30-minute gap at the end is enough", tail[0] === "Tuesday November 17, in the morning", JSON.stringify(tail));

  const allDay = labels([{ startAt: at("2026-11-17T05:00:00Z"), endAt: null, allDay: true }]);
  check("an all-day event takes the day", allDay[0]?.startsWith("Wednesday November 18") === true, JSON.stringify(allDay));

  const declined = labels([ev("2026-11-17T15:00:00Z", "2026-11-17T22:00:00Z", { selfResponse: "declined" })]);
  check("a declined meeting does not make the user busy", declined[0] === "Tuesday November 17, in the morning", JSON.stringify(declined));

  // The whole range booked solid: nothing to offer, not a made-up slot.
  const solid: BusyEvent[] = [ev("2026-11-14T00:00:00Z", "2026-11-30T00:00:00Z")];
  check("a full calendar: no windows", labels(solid).length === 0);

  // Same instant in Tokyo is Saturday morning, so Monday the 16th is business day 1 there too.
  const tokyo = labels([], "Asia/Tokyo");
  check("labels and days follow the user's time zone", tokyo[0] === "Tuesday November 17, in the morning", JSON.stringify(tokyo));

  // 1 November 2026 is the US fall-back day. From Thursday 29 October 23:30 New York, Friday the
  // 30th is business day 1 and Monday 2 November is business day 2.
  const dst = labels([], NY, at("2026-10-30T03:30:00Z"));
  check("a DST change does not repeat or skip a day", dst[0] === "Monday November 2, in the morning", JSON.stringify(dst));

  console.log("\nthe meeting ask");
  const withTimes = formatRules("email_cold", { windows: ["Tuesday November 17, in the morning", "Wednesday November 18, in the afternoon"] });
  check("two real windows: offered exactly, nothing else", withTimes.includes("offer exactly these two times from the user's calendar") && withTimes.includes("Tuesday November 17, in the morning, or Wednesday November 18, in the afternoon") && withTimes.includes("Offer no other time"));
  check("warm emails get them too", formatRules("email_warm", { windows: ["A", "B"] }).includes("exactly these two times"));
  const noTimes = formatRules("email_cold", { windows: null });
  check("no calendar: windows in words, never a date", noTimes.includes("Never invent a specific date") && !noTimes.includes("exactly these two times"));
  check("one window is not enough to offer", !formatRules("email_cold", { windows: ["A"] }).includes("exactly these two times"));

  console.log("\nthreading");
  const payload = outreachEmailPayload({ from: "a@x.dev", to: "b@y.dev", subject: "Re: Ramp's hiring", text: "Hi", replyTo: null, inReplyTo: "<abc@resend.dev>" }) as { headers?: Record<string, string> };
  check("a follow-up's Resend payload replies to the first email", payload.headers?.["In-Reply-To"] === "<abc@resend.dev>" && payload.headers?.References === "<abc@resend.dev>");
  const first = outreachEmailPayload({ from: "a@x.dev", to: "b@y.dev", subject: "Ramp's hiring", text: "Hi", replyTo: null }) as { headers?: unknown };
  check("a first email sets no reply headers", first.headers === undefined);
  check("follow-up subjects stay 'Re: <first>' however deep", replySubject("Re: Re: Ramp's hiring") === "Re: Ramp's hiring" && replySubject(null) === null);

  const send = readFileSync("src/lib/outreach-send.ts", "utf8");
  const footer = /function appendComplianceFooter[\s\S]*?\n}/.exec(send)?.[0] ?? "";
  check("the compliance footer has no em dash", footer.length > 0 && !/—/.test(footer.replace(/\/\/.*$/gm, "")));
  check("Gmail sends record Orbit's own Message-ID and thread", /rfcMessageId = newRfcMessageId\(\)[\s\S]*?threadId: input\.inThread\?\.threadId/.test(send));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll draft time and thread checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
