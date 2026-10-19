/**
 * Pins the holdout bucket: stable, roughly uniform, independent per flag, and capped.
 * Pure. Run: npx tsx scripts/smoke-holdout.ts
 */
import { HOLDOUT_MIN_PER_ARM, holdoutBucket, holdoutReadable, inHoldout } from "../src/lib/holdout";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const ids = Array.from({ length: 5000 }, (_, i) => `user_${i.toString(36).padStart(8, "0")}`);

check("the same account and flag always land in the same bucket", ids.every((id) => holdoutBucket(id, "a") === holdoutBucket(id, "a")));
check("buckets are 0 to 99", ids.every((id) => { const b = holdoutBucket(id, "a"); return b >= 0 && b < 100 && Number.isInteger(b); }));
const held = ids.filter((id) => inHoldout(id, "a", 20)).length;
check("a 20% holdout holds out about a fifth", held > 900 && held < 1100, `${held} of ${ids.length}`);
const both = ids.filter((id) => inHoldout(id, "a", 20) && inHoldout(id, "b", 20)).length;
check("two flags are independent (overlap near 4%)", both > 120 && both < 280, `${both} of ${ids.length}`);
check("the cap is half the accounts", ids.filter((id) => inHoldout(id, "a", 99)).length / ids.length < 0.55);
check("an unregistered flag holds nobody out", ids.every((id) => !inHoldout(id, "not-registered")));
check("zero percent holds nobody out", ids.every((id) => !inHoldout(id, "a", 0)));
check("a comparison needs enough in each arm", !holdoutReadable({ treated: 400, held: HOLDOUT_MIN_PER_ARM - 1 }) && holdoutReadable({ treated: 400, held: HOLDOUT_MIN_PER_ARM }));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll holdout checks passed.");
