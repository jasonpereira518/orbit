/**
 * One paste with several dated meetings splits into one segment per meeting; anything else
 * stays one note. Pure.
 *
 * Run: npx tsx scripts/smoke-split-meetings.ts
 */
import { headerDate, splitMeetings } from "../src/lib/capture/split-meetings";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const NOW = new Date("2026-11-09T15:00:00Z");

check("Nov 3", headerDate("Nov 3 — coffee with Sam", NOW) === "2026-11-03");
check("weekday + month", headerDate("Wednesday, November 5th: call with Priya", NOW) === "2026-11-05");
check("markdown ISO", headerDate("## 2026-10-30 Dinner", NOW) === "2026-10-30");
check("slashes", headerDate("11/6 lunch w/ Dana", NOW) === "2026-11-06");
check("day month", headerDate("2 Nov - intro call", NOW) === "2026-11-02");
check("no year, far ahead → last year", headerDate("Dec 20 holiday party", NOW) === "2025-12-20");
check("a sentence is not a header", headerDate("Met Sam for coffee on Nov 3 and talked about his raise at the new place.", NOW) === null);
check("no date, no header", headerDate("Coffee with Sam", NOW) === null);
check("Feb 30 is not a date", headerDate("Feb 30 thing", NOW) === null);

const week = `My notes this week

Nov 3 — Coffee with Sam Lee
Sam is moving to Stripe in January. Wants an intro to their infra team.

---

Nov 5 — Call with Priya Shah
Priya is hiring two PMs. Follow up next Tuesday with my friend's resume.`;
const parts = splitMeetings(week, NOW);
check("two meetings, two segments", parts.length === 2, String(parts.length));
check("each keeps its date", parts[0]?.dateIso === "2026-11-03" && parts[1]?.dateIso === "2026-11-05");
check("labels are the headers", parts[0]?.label === "Nov 3 — Coffee with Sam Lee" && parts[1]?.label === "Nov 5 — Call with Priya Shah", JSON.stringify(parts.map((p) => p.label)));
check("the title rides with the first meeting", parts[0]!.text.startsWith("My notes this week"));
check("Priya's notes are only hers", !parts[1]!.text.includes("Sam") && parts[1]!.text.includes("next Tuesday"));
check("separators are dropped", !parts[0]!.text.trimEnd().endsWith("---"));

check("one meeting stays one note", splitMeetings("Nov 3 — Coffee with Sam\nSam is moving to Stripe in January, wants intros.", NOW).length === 0);
check("a date mid-paragraph does not split", splitMeetings("Coffee with Sam.\nNov 3 he said he is moving.\nNov 5 he called again about it all.", NOW).length === 0);
check(
  "same date twice stays one note",
  splitMeetings("Nov 3 morning\nCoffee with Sam about Stripe and intros.\n\nNov 3 evening\nDinner with Priya about hiring PMs soon.", NOW).length === 0
);
check("an empty meeting means no split", splitMeetings("Nov 3\n\nNov 5\nCall with Priya about hiring two PMs.", NOW).length === 0);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll split-meetings checks passed.");
process.exit(0);
