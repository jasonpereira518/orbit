/**
 * Legacy Outreach wizard behaviour that has no database in it:
 *
 *   - An Apollo search failure the person can act on (a plan without people search, a rejected
 *     key, rate limiting) becomes Orbit's own words, not "That search didn’t work — try again?",
 *     which no retry can fix. Anything else stays an ordinary error, so its raw provider body
 *     never reaches a toast.
 *   - Follow-ups are chosen from the channel instead of a checkbox: email follows up twice,
 *     LinkedIn once, SMS never.
 *
 * Run: npx tsx scripts/smoke-legacy-outreach.ts
 */
import { apolloSearchError } from "../src/lib/apollo-errors";
import { friendlyError } from "../src/lib/errors";
import { DEFAULT_SEQUENCE_STEPS, smartSequenceFor } from "../src/lib/outreach-types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const FALLBACK = "That search didn’t work — try again?";
const shown = (status: number, body: string) => friendlyError(apolloSearchError(status, body), FALLBACK);

function main() {
  console.log("Apollo search errors...");
  const freePlan =
    '{"error":"The api/v1/mixed_people/search API is not included in your Free plan and is not accessible, even with a master key. All paid plans include full API access."}';
  check("a plan without people search says so", shown(403, freePlan).includes("Apollo plan doesn’t include people search"), shown(403, freePlan));
  check("a rejected key points at Settings", shown(401, '{"error":"Invalid access credentials."}').includes("check it in Settings"));
  check("a 403 that isn't about the plan is treated as the key", shown(403, '{"error":"forbidden"}').includes("check it in Settings"));
  check("rate limiting asks for a minute", shown(429, "Too Many Requests").includes("try again in a minute"));
  check("a server error keeps the generic fallback", shown(502, "<html>Bad Gateway</html>") === FALLBACK);
  check("the raw body never reaches the person", !shown(403, freePlan).includes("mixed_people"));
  const plain = apolloSearchError(500, "boom");
  check("an unexpected failure is still an Error with the status for the logs", plain instanceof Error && plain.message.includes("500"));

  console.log("Follow-ups by channel...");
  check("email follows up with the default sequence", JSON.stringify(smartSequenceFor("email")) === JSON.stringify(DEFAULT_SEQUENCE_STEPS));
  const linkedin = smartSequenceFor("linkedin");
  check("LinkedIn follows up once, after a week", linkedin.length === 1 && linkedin[0].delayDays === 7);
  check("SMS never follows up automatically", smartSequenceFor("sms").length === 0);
  check("the defaults aren't shared by reference", smartSequenceFor("email") !== DEFAULT_SEQUENCE_STEPS);

  if (failures) {
    console.error(`\n${failures} legacy outreach check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll legacy outreach checks passed.");
}

main();
