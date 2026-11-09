/**
 * `editedPurpose`: once the person edits a draft's purpose, it keeps going back as the override
 * — including after a draft made with it returns the edit as Orbit's "pick".
 * Pure. Run: npx tsx scripts/smoke-draft-purpose.ts
 */
import { editedPurpose } from "../src/components/follow-up/draft-purpose-row";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
}

check("untouched: no override", editedPurpose("Ask about the PM role", false) === undefined);
check("edited: the trimmed line", editedPurpose("  Ask for a referral ", true) === "Ask for a referral");
check("edited, then echoed back as the pick: still sent", editedPurpose("Ask for a referral", true) === "Ask for a referral");
check("cleared: no override", editedPurpose("   ", true) === undefined);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ndraft-purpose: ok");
process.exit(0);
