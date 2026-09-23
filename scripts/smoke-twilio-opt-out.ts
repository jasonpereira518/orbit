/**
 * Twilio enforces STOP by rejecting later sends with 21610. That must read as "opted out",
 * never as a transient failure worth retrying.
 * Run: npx tsx scripts/smoke-twilio-opt-out.ts
 */
import { SMS_OPTED_OUT_MESSAGE, TWILIO_OPTED_OUT, isTwilioOptOut } from "../src/lib/twilio-errors";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const restException = Object.assign(new Error("Attempt to send to unsubscribed recipient"), { code: 21610, status: 400 });
check("Twilio's 21610 is an opt-out", isTwilioOptOut(restException));
check("the constant is 21610", TWILIO_OPTED_OUT === 21610);
check("another Twilio error is not", !isTwilioOptOut(Object.assign(new Error("Invalid 'To' Phone Number"), { code: 21211 })));
check("a string code is not", !isTwilioOptOut({ code: "21610" }));
check("junk is not", !isTwilioOptOut(null) && !isTwilioOptOut("21610"));
check("house voice", !SMS_OPTED_OUT_MESSAGE.includes("'") && !SMS_OPTED_OUT_MESSAGE.endsWith(".") && !/failed/i.test(SMS_OPTED_OUT_MESSAGE));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
