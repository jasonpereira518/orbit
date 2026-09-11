/**
 * Guards the checks behind "don't claim success you didn't have".
 *
 * Four buttons reported success after doing nothing:
 *
 *   1. Constellation Refresh spent 15-20s across five round trips and finished with a
 *      green "Constellation refreshed" having rebuilt zero embeddings — the action
 *      computed a `failed` count, logged it, recorded an error event, and then did not
 *      return it, while the embedding helper swallowed every provider error so `failed`
 *      was always 0 anyway.
 *   2. Bulk send always called `toast.success`, so a run where every message failed —
 *      the default state until Resend or Twilio is configured — produced a green
 *      "Sent 0, failed 12" with the per-message reason shown nowhere.
 *   3. A malformed .ics parsed to `[]`, byte-identical to a valid empty calendar, and
 *      was reported as "0 events in window" in a success toast.
 *   4. Settings stored any string as an API key and said "Your key is saved".
 *
 * This file covers the two pure predicates. The rest are asserted in the browser and by
 * `smoke-constellation-*`.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-honest-reporting.ts
 */
import { looksLikeCalendar, parseIcsEvents } from "../src/lib/calendar-import";
import { isUnmailableAddress } from "../src/lib/outreach-types";
import { canAutoSend, isDemoProspect } from "../src/lib/outreach-channels";
import { formatDueLabel } from "../src/lib/dates";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const VALID_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Orbit//Smoke//EN",
  "BEGIN:VEVENT",
  "UID:evt-1@example.com",
  "DTSTART:20260910T150000Z",
  "DTEND:20260910T160000Z",
  "SUMMARY:Coffee with Dana",
  "ATTENDEE;CN=Dana Whitfield:mailto:dana@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** A real export cut off mid-transfer: the wrapper never closes. */
const TRUNCATED_ICS = VALID_ICS.slice(0, 120);

function main() {
  console.log("\ncalendar payload validation");

  check("a real export is recognised", looksLikeCalendar(VALID_ICS));
  check(
    "an empty-but-valid calendar is still a calendar",
    looksLikeCalendar("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR"),
    "a subscribed feed with no upcoming events is legitimate"
  );
  check("leading and trailing whitespace is tolerated", looksLikeCalendar(`\n\n${VALID_ICS}\n`));

  check("an empty string is rejected", !looksLikeCalendar(""));
  check("whitespace alone is rejected", !looksLikeCalendar("   \n\t "));
  check(
    "an HTML error page saved as .ics is rejected",
    !looksLikeCalendar("<!doctype html><html><body>404 Not Found</body></html>")
  );
  check("a CSV is rejected", !looksLikeCalendar("Subject,Start Date\r\nCoffee,2026-09-10"));
  check("arbitrary prose is rejected", !looksLikeCalendar("Met Dana at the summit."));
  check(
    "a truncated export that lost its header is rejected",
    !looksLikeCalendar(TRUNCATED_ICS.replace("BEGIN:VCALENDAR", "")),
    "this is the case that used to report '0 events' as a success"
  );

  console.log("\nthe ambiguity this removes");

  // The whole point: without the guard these three are indistinguishable at the call site.
  const emptyResult = parseIcsEvents("");
  const garbageResult = parseIcsEvents("this is not a calendar at all");
  const validEmpty = parseIcsEvents("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
  check(
    "parseIcsEvents still returns [] for all three, as before",
    emptyResult.length === 0 && garbageResult.length === 0 && validEmpty.length === 0,
    "kept total on purpose — the feed sync and capture ingest rely on it"
  );
  check(
    "but looksLikeCalendar separates the legitimate one from the two mistakes",
    !looksLikeCalendar("") &&
      !looksLikeCalendar("this is not a calendar at all") &&
      looksLikeCalendar("BEGIN:VCALENDAR\r\nEND:VCALENDAR")
  );

  check(
    "a valid file still parses its events",
    parseIcsEvents(VALID_ICS).length === 1,
    `got ${parseIcsEvents(VALID_ICS).length}`
  );

  console.log("\nfabricated prospects are structurally un-sendable");

  const demo = {
    externalId: "demo-stripe-1",
    email: "alex.chen@demo.orbit.invalid",
    phone: "+14155551001",
    enrichment: { demo: true },
  };
  const real = { externalId: "apollo-abc", email: "dana@stripe.com", phone: "+14155550123" };

  check("a demo row is recognised by its id", isDemoProspect({ externalId: "demo-x-1" }));
  check("and by its enrichment flag", isDemoProspect({ enrichment: { demo: true } }));
  check("a real prospect is not", !isDemoProspect(real));

  check("email send is refused for a demo prospect", !canAutoSend("email", demo));
  check("sms send is refused for a demo prospect", !canAutoSend("sms", demo));
  check("a real prospect can still be sent to", canAutoSend("email", real));
  check("linkedin auto-send stays unsupported", !canAutoSend("linkedin", real));

  // The UI rows that call canAutoSend carry `email` but not `externalId`/`enrichment`,
  // so the address check is what actually protects them.
  check(
    "an unmailable address alone is enough to refuse",
    !canAutoSend("email", { email: "alex.chen@demo.orbit.invalid" })
  );

  check("RFC 2606 example.com is unmailable", isUnmailableAddress("a@foo.example.com"));
  check("RFC 6761 .invalid is unmailable", isUnmailableAddress("a@demo.orbit.invalid"));
  check("bare example.com is unmailable", isUnmailableAddress("a@example.com"));
  check(".test and .localhost are unmailable",
    isUnmailableAddress("a@x.test") && isUnmailableAddress("a@x.localhost"));
  check("an address with no domain is unmailable", isUnmailableAddress("nonsense"));
  check("a real address is mailable", !isUnmailableAddress("dana@stripe.com"));
  check(
    "a domain merely CONTAINING 'test' is still mailable",
    !isUnmailableAddress("dana@testing-labs.com"),
    "the check is anchored to the TLD, not a substring"
  );

  console.log("\ndue labels say the same thing everywhere");

  const noon = new Date(2026, 8, 10, 12, 0, 0);
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h);

  check(
    "a reminder due this morning is 'Due today', not 'Overdue 1 day'",
    formatDueLabel(at(2026, 8, 10, 9), noon)?.text === "Due today",
    `got "${formatDueLabel(at(2026, 8, 10, 9), noon)?.text}"`
  );
  check(
    "one created seconds ago is 'Due today'",
    formatDueLabel(noon, noon)?.text === "Due today"
  );
  check("tomorrow reads as tomorrow", formatDueLabel(at(2026, 8, 11), noon)?.text === "Due tomorrow");
  check(
    "genuinely overdue keeps the word Overdue",
    formatDueLabel(at(2026, 8, 3), noon)?.text === "Overdue 7 days"
  );
  check(
    "one day overdue is singular",
    formatDueLabel(at(2026, 8, 9), noon)?.text === "Overdue 1 day"
  );
  check("tone marks overdue", formatDueLabel(at(2026, 8, 3), noon)?.tone === "overdue");
  check("tone marks today", formatDueLabel(noon, noon)?.tone === "today");
  check("a null due date has no label", formatDueLabel(null) === null);
  check("an unparseable date has no label", formatDueLabel("not-a-date") === null);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll honest-reporting checks passed.");
  process.exit(0);
}

main();
