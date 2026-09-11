/**
 * Guards the four shared primitives introduced to fix a cluster of unrelated-looking bugs.
 *
 * Each block below pins the behaviour of one helper AND the specific defect it exists to
 * prevent, because in every case the helper looks redundant until you know the story:
 *
 *   1. `isUuid`      — a malformed route param reached a `uuid` column and made Postgres
 *                      throw 22P02, so a stale link rendered the generic error boundary
 *                      ("Orbit hit a snag", with a Try again that re-ran the same failing
 *                      render) instead of the 404 the route already knew how to draw.
 *   2. `@/lib/dates` — `new Date("2026-09-25")` parses as UTC midnight, which is the 24th
 *                      anywhere west of UTC. Reminder due dates walked back one day on
 *                      every open-and-save, permanently.
 *   3. errors        — "no key configured" was identified by testing a message against
 *                      /api key/i, which also matched the accurate "Invalid Gemini API
 *                      key…" and rewrote it to "Add your AI API key in Settings." Users
 *                      with a bad key were told, forever, that they had no key.
 *   4. contact input — `ContactInput` was an unvalidated type shared by the form, the
 *                      extension, the public API and every importer. Whitespace names and
 *                      10,000-character names both got in.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-phase0-primitives.ts
 */
import { isUuid } from "../src/lib/ids";
import {
  calendarDaysBetween,
  isCalendarDayString,
  isoDay,
  isoDayToLocalNoon,
  parseDueDateInput,
} from "../src/lib/dates";
import {
  MISSING_AI_API_KEY_MESSAGE,
  MissingAiKeyError,
  aiProviderErrorMessage,
  classifyAiError,
  isMissingAiApiKeyError,
  isMissingAiApiKeyMessage,
  toUserFacingError,
} from "../src/lib/errors";
import {
  normalizeContactInput,
  parseContactInput,
  parseContactPatch,
} from "../src/lib/contact-input";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function section(name: string) {
  console.log(`\n${name}`);
}

function main() {
  // ---------------------------------------------------------------- 1. isUuid
  section("route id guard");
  check("accepts a real uuid", isUuid("0d7a7b55-040d-4f07-8a00-afc33115df9d"));
  check("accepts uppercase", isUuid("0D7A7B55-040D-4F07-8A00-AFC33115DF9D"));
  check("rejects the reported crash input", !isUuid("does-not-exist"));
  check("rejects an empty string", !isUuid(""));
  check("rejects null and undefined", !isUuid(null) && !isUuid(undefined));
  check("rejects a uuid with trailing text", !isUuid("0d7a7b55-040d-4f07-8a00-afc33115df9d'"));
  check("rejects a too-short group", !isUuid("0d7a7b5-040d-4f07-8a00-afc33115df9d"));
  // SQL metacharacters must never look like a valid id.
  check("rejects an injection attempt", !isUuid("' OR 1=1 --"));

  // ----------------------------------------------------------------- 2. dates
  section("calendar-day handling");
  check("recognises a bare calendar day", isCalendarDayString("2026-09-25"));
  check("rejects a full timestamp", !isCalendarDayString("2026-09-25T00:00:00Z"));

  const picked = parseDueDateInput("2026-09-25");
  check(
    "a picked day round-trips to the same day",
    isoDay(picked) === "2026-09-25",
    `got ${isoDay(picked)}`
  );
  // The ratchet: read it back, write it again, read it again.
  const secondPass = parseDueDateInput(isoDay(picked));
  const thirdPass = parseDueDateInput(isoDay(secondPass));
  check(
    "repeated edit/save cycles do not walk the date backwards",
    isoDay(thirdPass) === "2026-09-25",
    `after three passes: ${isoDay(thirdPass)}`
  );
  check(
    "anchored at noon, so no timezone offset can cross a day boundary",
    isoDayToLocalNoon("2026-09-25").getHours() === 12
  );
  // Why noon and not midnight: the value survives ±11h of offset either way.
  const noonUtcMs = Date.UTC(2026, 8, 25, 12, 0, 0);
  check(
    "noon UTC is still the 25th from UTC-11 to UTC+11",
    new Date(noonUtcMs - 11 * 3600_000).getUTCDate() === 25 &&
      new Date(noonUtcMs + 11 * 3600_000).getUTCDate() === 25
  );
  check(
    "a full timestamp is left to the platform parser",
    parseDueDateInput("2026-09-25T08:30:00Z").toISOString() ===
      "2026-09-25T08:30:00.000Z"
  );

  // The "Overdue 1 day" bug: a same-day item must be 0 days away, not floored up to 1.
  const morning = new Date(2026, 8, 10, 9, 0, 0);
  const evening = new Date(2026, 8, 10, 17, 0, 0);
  check(
    "a reminder due this morning is 0 calendar days from this evening",
    calendarDaysBetween(evening, morning) === 0,
    `got ${calendarDaysBetween(evening, morning)}`
  );
  check(
    "tomorrow is +1 even across a sub-24h gap",
    calendarDaysBetween(evening, new Date(2026, 8, 11, 1, 0, 0)) === 1
  );
  check(
    "yesterday is -1",
    calendarDaysBetween(morning, new Date(2026, 8, 9, 23, 0, 0)) === -1
  );

  // ---------------------------------------------------------------- 3. errors
  section("AI error classification");
  const missing = new MissingAiKeyError(
    "No Gemini API key configured. Add your own key in Settings."
  );
  const invalid = new Error(
    "Invalid Gemini API key. Update it in Settings or check your server env key."
  );
  const rateLimited = new Error("429 rate limit exceeded");

  check("a missing key is recognised by type", isMissingAiApiKeyError(missing));
  check(
    "a missing key wrapped as a cause is still recognised",
    isMissingAiApiKeyError(
      Object.assign(new Error("An error occurred in the Server Components render"), {
        cause: missing,
      })
    )
  );
  check("an invalid key is NOT a missing key", !isMissingAiApiKeyError(invalid));
  check("a rate limit is not a missing key", !isMissingAiApiKeyError(rateLimited));

  check(
    "a missing key normalizes to the Settings prompt",
    toUserFacingError(missing).message === MISSING_AI_API_KEY_MESSAGE
  );
  // The regression that started all this.
  check(
    "an invalid key keeps its own message instead of being rewritten",
    toUserFacingError(invalid).message === invalid.message,
    `got "${toUserFacingError(invalid).message}"`
  );
  check(
    "aiProviderErrorMessage reports a missing key as missing",
    aiProviderErrorMessage(missing, "Gemini") === MISSING_AI_API_KEY_MESSAGE,
    `got "${aiProviderErrorMessage(missing, "Gemini")}"`
  );
  check(
    "aiProviderErrorMessage reports a rejected key as invalid",
    /^Invalid Gemini API key/.test(aiProviderErrorMessage(invalid, "Gemini"))
  );
  check(
    "a rate limit is still classified as a rate limit",
    classifyAiError(rateLimited) === "rate_limit"
  );
  check("a missing key classifies as auth", classifyAiError(missing) === "auth");

  // The client only ever sees a message, so its check must be exact.
  check(
    "the client-side check matches the normalized message",
    isMissingAiApiKeyMessage(MISSING_AI_API_KEY_MESSAGE)
  );
  check(
    "the client-side check does NOT match an invalid-key message",
    !isMissingAiApiKeyMessage(invalid.message)
  );
  check("the client-side check ignores empty input", !isMissingAiApiKeyMessage(""));

  // -------------------------------------------------------- 4. contact input
  section("contact input contract");
  check(
    "a whitespace-only name is rejected",
    !normalizeContactInput({ fullName: "   " }).ok
  );
  check("an empty name is rejected", !normalizeContactInput({ fullName: "" }).ok);
  check(
    "a 10,000-character name is rejected",
    !normalizeContactInput({ fullName: "x".repeat(10_000) }).ok
  );
  check(
    "a normal name is accepted and trimmed",
    (() => {
      const r = normalizeContactInput({ fullName: "  Sarah Chen  " });
      return r.ok && r.value.fullName === "Sarah Chen";
    })()
  );
  check(
    "unicode and emoji names survive",
    (() => {
      const r = normalizeContactInput({ fullName: "田中 陽子 🚀" });
      return r.ok && r.value.fullName === "田中 陽子 🚀";
    })()
  );
  check(
    "a malformed email is rejected in strict mode",
    !normalizeContactInput({ fullName: "A", email: "not-an-email" }).ok
  );
  check(
    "a non-LinkedIn URL is rejected for the LinkedIn field",
    !normalizeContactInput({
      fullName: "A",
      linkedinUrl: "https://evil.example.com/not-linkedin",
    }).ok
  );
  check(
    "a real LinkedIn URL is accepted",
    normalizeContactInput({
      fullName: "A",
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
    }).ok
  );
  check(
    "a regional LinkedIn subdomain is accepted",
    normalizeContactInput({
      fullName: "A",
      linkedinUrl: "https://uk.linkedin.com/in/sarah-chen",
    }).ok,
    "real Connections.csv exports contain these"
  );
  check(
    "a scheme-less LinkedIn URL is accepted",
    normalizeContactInput({
      fullName: "A",
      linkedinUrl: "linkedin.com/in/sarah-chen",
    }).ok
  );

  // Lenient mode checks the name and nothing else, on purpose: the import engine's
  // `writeWithNarrowing` already isolates a row the database refuses and surfaces it in
  // `failedRows`. Quietly dropping fields here would turn a visible, recoverable failure
  // into an invisible one — and would neuter the poison-row coverage in
  // scripts/smoke-import-engine.ts, which exists to prove that narrowing still works.
  const lenient = normalizeContactInput(
    {
      fullName: "  Dana Whitfield  ",
      email: "definitely not an email",
      linkedinUrl: "https://example.com/nope",
      company: "x".repeat(3000),
    },
    "lenient"
  );
  check("lenient mode keeps a row with messy optional fields", lenient.ok);
  check(
    "lenient mode still trims the name",
    lenient.ok && lenient.value.fullName === "Dana Whitfield"
  );
  check(
    "lenient mode passes every other field through untouched",
    lenient.ok &&
      lenient.value.email === "definitely not an email" &&
      lenient.value.linkedinUrl === "https://example.com/nope" &&
      lenient.value.company?.length === 3000,
    "the import engine, not this schema, decides what to do with these"
  );
  check(
    "lenient mode still rejects a row with no usable name",
    !normalizeContactInput({ fullName: "  ", company: "Acme" }, "lenient").ok
  );
  check(
    "lenient mode still rejects an unusable 10k name",
    !normalizeContactInput({ fullName: "x".repeat(10_000) }, "lenient").ok
  );

  check(
    "the throwing form reports the field problem, not a generic message",
    (() => {
      try {
        parseContactInput({ fullName: " " });
        return false;
      } catch (err) {
        return (err as Error).message === "Name is required";
      }
    })()
  );

  // A patch must not be judged on fields it never sends.
  check(
    "a patch touching only company is accepted",
    (() => {
      const patched = parseContactPatch({ company: "Stripe" });
      return patched.company === "Stripe" && !("fullName" in patched);
    })()
  );
  check(
    "a patch clearing a field keeps the clear",
    parseContactPatch({ company: "" }).company === null
  );
  check(
    "a patch with a bad name is rejected",
    (() => {
      try {
        parseContactPatch({ fullName: "   " });
        return false;
      } catch {
        return true;
      }
    })()
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Phase 0 primitive checks passed.");
  process.exit(0);
}

main();
