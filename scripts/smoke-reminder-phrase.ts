/**
 * What ⌘K reads as a reminder: "remind me to call Sam friday" → "Call Sam", due that Friday.
 *
 * The parser is conservative by design: a trigger phrase is required (so a note about Friday's
 * meeting is never hijacked), and a date it does not recognise stays in the title rather than
 * being guessed. "Now" is fixed — Wednesday 11 November 2026 — so every date below is exact.
 *
 * Pure.
 *
 * Run: npx tsx scripts/smoke-reminder-phrase.ts
 */
import { parseReminderPhrase } from "../src/lib/reminder-phrase";

const NOW = new Date(2026, 10, 11, 9, 30); // Wednesday

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}
function is(text: string, title: string, due: string | null) {
  const got = parseReminderPhrase(text, NOW);
  check(`${JSON.stringify(text)} → ${JSON.stringify(title)}, ${due ?? "no date"}`, got?.title === title && got?.due === due, JSON.stringify(got));
}
function not(text: string) {
  const got = parseReminderPhrase(text, NOW);
  check(`${JSON.stringify(text)} is not a reminder`, got === null, JSON.stringify(got));
}

console.log("The headline case, in the ways people say it");
is("remind me to call Sam friday", "Call Sam", "2026-11-13");
is("Remind me to call Sam on Friday", "Call Sam", "2026-11-13");
is("remind me friday to call Sam", "Call Sam", "2026-11-13");
is("remind me to call Sam by friday", "Call Sam", "2026-11-13");
is("REMIND ME TO CALL SAM FRIDAY", "CALL SAM", "2026-11-13");
is("remind me to call Sam friday.", "Call Sam", "2026-11-13");

console.log("\nOther openings");
is("don't forget to bring the deck friday", "Bring the deck", "2026-11-13");
is("dont forget the deck tomorrow", "The deck", "2026-11-12");
is("remember to renew the passport next week", "Renew the passport", "2026-11-16");
is("reminder: send the intro tomorrow", "Send the intro", "2026-11-12");
is("todo call the bank", "Call the bank", null);
is("follow up with Sam friday", "Follow up with Sam", "2026-11-13"); // the opening is part of the title

console.log("\nDates, relative to Wednesday 11 November");
is("remind me to ping Sam today", "Ping Sam", "2026-11-11");
is("remind me to ping Sam tonight", "Ping Sam", "2026-11-11");
is("remind me to ping Sam tomorrow", "Ping Sam", "2026-11-12");
is("remind me to ping Sam tmrw", "Ping Sam", "2026-11-12");
is("remind me to ping Sam wednesday", "Ping Sam", "2026-11-18"); // the coming one is never today…
is("remind me to ping Sam this wednesday", "Ping Sam", "2026-11-11"); // …unless "this" says today counts
is("remind me to ping Sam thursday", "Ping Sam", "2026-11-12");
is("remind me to ping Sam tue", "Ping Sam", "2026-11-17");
is("remind me to ping Sam next friday", "Ping Sam", "2026-11-20"); // the Friday of NEXT week
is("remind me to ping Sam next monday", "Ping Sam", "2026-11-16");
is("remind me to ping Sam next week", "Ping Sam", "2026-11-16");
is("remind me to ping Sam next month", "Ping Sam", "2026-12-01");
is("remind me to ping Sam in 3 days", "Ping Sam", "2026-11-14");
is("remind me to ping Sam in 2 weeks", "Ping Sam", "2026-11-25");
is("remind me to ping Sam in a month", "Ping Sam", "2026-12-11");
is("remind me to ping Sam in two weeks", "Ping Sam", "2026-11-25");
is("remind me to ping Sam dec 3", "Ping Sam", "2026-12-03");
is("remind me to ping Sam december 3rd", "Ping Sam", "2026-12-03");
is("remind me to ping Sam 3 dec", "Ping Sam", "2026-12-03");
is("remind me to ping Sam 11/20", "Ping Sam", "2026-11-20");
is("remind me to ping Sam 2026-11-20", "Ping Sam", "2026-11-20");

console.log("\nA date that has passed this year means next year's");
is("remind me to ping Sam jan 5", "Ping Sam", "2027-01-05");
is("remind me to ping Sam 11/11", "Ping Sam", "2026-11-11"); // today is not past
is("remind me to ping Sam 11/10", "Ping Sam", "2027-11-10");

console.log("\nWhat it will not guess");
is("remind me to call Sam feb 30", "Call Sam feb 30", null); // there is no 30 February
is("remind me to rest sun", "Rest sun", null); // "sun", "sat" and "mon" are ordinary words
is("remind me to call Sam at some point", "Call Sam at some point", null);
is("remind me about the offer letter", "The offer letter", null);

console.log("\nMore than one date: the last one wins, the rest stay in the title");
is("remind me to send the 12/3 deck friday", "Send the 12/3 deck", "2026-11-13");

console.log("\nA sentence is a reminder only if it says so");
not("met Sarah at AWS friday");
not("friday");
not("call Sam tomorrow");
not("reminders");
not("reminder"); // the page name, typed to go there
not("remind me");
not("remind me to");
not("remind me friday"); // a date and nothing to be reminded of
not("remembering friday");
not("");
not("   ");

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-reminder-phrase: all checks passed");
process.exit(0);
