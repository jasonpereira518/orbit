/**
 * The save-time duplicate re-check merges a "New" card only into a contact that appeared
 * after the parse — never into one the card showed and the person declined. Pure.
 * Run: npx tsx scripts/smoke-capture-merge-target.ts
 */
import { saveTimeMergeTarget } from "../src/lib/capture/review-reducer";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const shown = { duplicates: [{ id: "c-shown", fullName: "Priya Raman", company: "Loom", title: null, reason: "Same name", confidence: 0.9 }] };
const none = { duplicates: [] };
const T = 0.85;

check("an explicit merge choice wins", saveTimeMergeTarget(shown, { mergeContactId: "c-chosen" }, { id: "c-other", confidence: 0.99 }, T) === "c-chosen");
check("no candidate, no merge", saveTimeMergeTarget(none, { mergeContactId: null }, null, T) === null);
check("a weak candidate, no merge", saveTimeMergeTarget(none, { mergeContactId: null }, { id: "c-new", confidence: 0.6 }, T) === null);
check("a declined candidate is never merged into", saveTimeMergeTarget(shown, { mergeContactId: null }, { id: "c-shown", confidence: 0.99 }, T) === null);
check("a contact that appeared after the parse is", saveTimeMergeTarget(shown, { mergeContactId: null }, { id: "c-new", confidence: 0.95 }, T) === "c-new");

if (failures) {
  console.error(`\nsmoke-capture-merge-target: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-capture-merge-target: ok");
process.exit(0);
