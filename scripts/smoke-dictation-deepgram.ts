/**
 * The Deepgram half of dictation: folding a stream of `LiveResult`s into a running
 * (committed, interim) pair. Pure — no DOM, no socket, no React.
 * Run: npx tsx scripts/smoke-dictation-deepgram.ts
 */
import { foldResults, type FoldState } from "../src/lib/dictation-fold";
import type { LiveResult } from "../src/lib/deepgram-live";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

function final(text: string): LiveResult {
  return { text, final: true, startMs: 0, endMs: 0, words: [] };
}
function interim(text: string): LiveResult {
  return { text, final: false, startMs: 0, endMs: 0, words: [] };
}

console.log("\nfoldResults");

check(
  "a final result commits",
  foldResults({ committed: "", interim: "" }, final("Met Priya")).committed === "Met Priya",
);
check(
  "an interim does not commit",
  foldResults({ committed: "Met Priya", interim: "" }, interim("at")).committed === "Met Priya",
);
check(
  "a later interim replaces the earlier one",
  foldResults({ committed: "", interim: "at" }, interim("at Stripe")).interim === "at Stripe",
);
check(
  "a final clears the interim",
  foldResults({ committed: "", interim: "at" }, final("at Stripe")).interim === "",
);
check(
  "finals join with a space",
  foldResults({ committed: "Met Priya", interim: "" }, final("at Stripe")).committed ===
    "Met Priya at Stripe",
);

// A few more, from the shape of a real session.
check(
  "an empty final commits nothing",
  foldResults({ committed: "Met Priya", interim: "at" }, final("")).committed === "Met Priya",
);
check(
  "an empty final still clears the interim",
  foldResults({ committed: "Met Priya", interim: "at" }, final("")).interim === "",
);
check(
  "an interim after a final replaces the (now empty) interim",
  foldResults({ committed: "Met Priya", interim: "" }, interim("at Stripe")).interim === "at Stripe",
);
{
  // A whole short session, folded one result at a time.
  const events: LiveResult[] = [
    interim("Met"),
    interim("Met Priya"),
    final("Met Priya"),
    interim("at"),
    interim("at Stripe"),
    final("at Stripe"),
  ];
  const end = events.reduce<FoldState>((state, r) => foldResults(state, r), { committed: "", interim: "" });
  check("a full session ends fully committed", end.committed === "Met Priya at Stripe");
  check("a full session ends with no dangling interim", end.interim === "");
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll Deepgram dictation fold checks passed");
process.exit(0);
