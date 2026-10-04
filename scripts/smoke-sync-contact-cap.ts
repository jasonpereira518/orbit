/**
 * The held-back-people rules a contacts sync applies to its cursor.
 *
 * The behaviour that matters is the one no other test can see: after an upgrade nothing tells
 * the sync anything changed, so it must notice room for itself. And it must NOT re-read a
 * whole address book every half hour while there is still no room, or a free user with a
 * 5,000-person book pays for a full read forever to be turned away every time.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import {
  initialBlockedCount,
  startCursorForCap,
  withBlockedCount,
} from "../src/lib/sync-contact-cap";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  type Cursor = { syncToken: string; pageToken: null; blockedByPlan?: number | null };
  const held: Cursor = { syncToken: "tok", pageToken: null, blockedByPlan: 214 };
  // Typed with the optional field so it matches a stored cursor from before `blockedByPlan`
  // existed: one that simply never had it.
  const clean: Cursor = { syncToken: "tok", pageToken: null };

  console.log("where a run starts");
  check("people held back and no room yet: keep the delta cursor", startCursorForCap(held, 0) === held);
  check("people held back and room now: read the whole book again", startCursorForCap(held, 50) === null);
  check("people held back and the plan is unlimited: read the whole book again", startCursorForCap(held, null) === null);
  check("nobody held back: the cursor is left alone", startCursorForCap(clean, 0) === clean);
  check("a zero count is 'none held back', not a reason to re-read", startCursorForCap({ ...clean, blockedByPlan: 0 }, 100)?.syncToken === "tok");
  check("no cursor at all stays no cursor", startCursorForCap(null, 100) === null);

  console.log("\nthe running count");
  check("a fresh read starts at zero", initialBlockedCount(null) === 0);
  check("a resumed read continues from what it had counted", initialBlockedCount(held) === 214);
  check("an old cursor that never had the field starts at zero", initialBlockedCount(clean) === 0);

  console.log("\nstamping it back");
  const stamped = withBlockedCount({ syncToken: "t", pageToken: "p" }, 12);
  check("the count is written beside the tokens", stamped.blockedByPlan === 12 && stamped.syncToken === "t" && stamped.pageToken === "p");
  check("zero is stored as null so 'none waiting' is one state, not two", withBlockedCount({ syncToken: "t" }, 0).blockedByPlan === null);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll contact cap checks passed.");
});
