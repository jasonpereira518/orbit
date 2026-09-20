/**
 * The three routes the Shortcut, the Obsidian plugin and Zapier need.
 *
 * Checked at the schema level rather than over HTTP: the auth, rate-limit and error mapping
 * are `apiHandler`'s and already covered; what is new here is the request contracts.
 */
import { followupPatchBody, interactionsQuery, noteBody, parseQuery } from "../src/lib/api/schemas";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("notes");
check("a note with text parses", noteBody.safeParse({ text: "Met Ada at the museum" }).success);
check("an empty note is rejected", !noteBody.safeParse({ text: "" }).success);
check(
  "a source label is optional and bounded",
  noteBody.safeParse({ text: "hi", sourceLabel: "Apple Notes" }).success
);
check(
  "an oversized note is rejected",
  !noteBody.safeParse({ text: "x".repeat(50_001) }).success
);

console.log("\ninteractions");
const ok = parseQuery("https://x/api/v1/interactions?limit=10", interactionsQuery);
check("a plain query parses", ok.ok === true);
const since = parseQuery(
  "https://x/api/v1/interactions?updated_since=2026-09-01T00:00:00.000Z",
  interactionsQuery
);
check("updated_since parses", since.ok === true);
const bad = parseQuery("https://x/api/v1/interactions?updated_since=nope", interactionsQuery);
check("a bad updated_since is rejected", bad.ok === false);
const tooMany = parseQuery("https://x/api/v1/interactions?limit=5000", interactionsQuery);
check("an oversized limit is rejected", tooMany.ok === false);

console.log("\nfollow-up patch");
check("complete parses", followupPatchBody.safeParse({ status: "complete" }).success);
check(
  "snooze needs a date",
  !followupPatchBody.safeParse({ status: "snoozed" }).success
);
check(
  "snooze with a date parses",
  followupPatchBody.safeParse({ status: "snoozed", dueAt: "2026-10-01T09:00:00.000Z" }).success
);
check("an unknown status is rejected", !followupPatchBody.safeParse({ status: "yolo" }).success);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll connector API schema checks passed.");
process.exit(0);
