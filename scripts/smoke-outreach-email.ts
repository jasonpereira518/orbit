/**
 * Pins the Resend payload for outreach email (audit A11): hosted mail goes out from
 * Orbit's RESEND_FROM_EMAIL, so without `replyTo` a recruiter's reply landed in Orbit's
 * inbox instead of the user's.
 *
 * Pure. Run: npx tsx scripts/smoke-outreach-email.ts
 */
import { outreachEmailPayload } from "../src/lib/outreach-email";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const base = { from: "Orbit <outreach@orbit.example>", to: "jordan@acme.example.com", text: "Hi Jordan" };
const withReply = outreachEmailPayload({ ...base, subject: "Coffee?", replyTo: "  me@person.example.com " });
check("replies go to the sender", withReply.replyTo === "me@person.example.com", JSON.stringify(withReply));
check("…while the From stays Orbit's verified address", withReply.from === base.from);
const noReply = outreachEmailPayload({ ...base, subject: "Coffee?", replyTo: null });
check("no sender email → no replyTo key at all (never an empty string)", !("replyTo" in noReply), JSON.stringify(noReply));
check("a blank subject still gets one", outreachEmailPayload({ ...base, subject: "  ", replyTo: null }).subject === "Hello");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll outreach email checks passed.");
process.exit(0);
