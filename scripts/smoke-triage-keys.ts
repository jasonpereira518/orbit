/**
 * Pins `src/lib/triage-keys.ts`: which key maps to which reminders-queue command, and —
 * the part worth guarding — when a key must be left alone. A single-letter shortcut that
 * fires while someone types in the search box marks a reminder done under their cursor.
 *
 * Pure. Run: npx tsx scripts/smoke-triage-keys.ts
 */
import { triageCommandFor, TRIAGE_SHORTCUTS, type TriageKeyInput } from "../src/lib/triage-keys";

let failures = 0;
function eq<T>(label: string, got: T, want: T) {
  if (got === want) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}\n       got  ${String(got)}\n       want ${String(want)}`);
  }
}

const base: TriageKeyInput = {
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  targetTag: "body",
  targetEditable: false,
  overlayOpen: false,
};
const press = (key: string, over: Partial<TriageKeyInput> = {}) =>
  triageCommandFor({ ...base, key, ...over });

console.log("mapping");
eq("j → next", press("j"), "next");
eq("ArrowDown → next", press("ArrowDown"), "next");
eq("k → prev", press("k"), "prev");
eq("e → done", press("e"), "done");
eq("s → snooze", press("s"), "snooze");
eq("x → select", press("x"), "toggleSelect");
eq("# → delete", press("#"), "delete");
eq("Delete → delete", press("Delete"), "delete");
eq("/ → search", press("/"), "search");
eq("Escape → close", press("Escape"), "close");
eq("unmapped key → nothing", press("q"), null);
eq("capital E is not e (Shift held)", press("E"), null);

console.log("\nguard");
eq("typing in an input", press("e", { targetTag: "input" }), null);
eq("typing in a textarea", press("e", { targetTag: "textarea" }), null);
eq("typing in a contenteditable", press("e", { targetTag: "div", targetEditable: true }), null);
eq("a select owns its keys", press("ArrowDown", { targetTag: "select" }), null);
eq("⌘K belongs to the palette", press("k", { metaKey: true }), null);
eq("Ctrl+F belongs to the browser", press("f", { ctrlKey: true }), null);
eq("Alt-modified keys are left alone", press("e", { altKey: true }), null);
eq("an open overlay owns the keyboard", press("e", { overlayOpen: true }), null);
eq("…including Escape", press("Escape", { overlayOpen: true }), null);
eq("Enter on a focused button is the button's", press("Enter", { targetTag: "button" }), null);
eq("Enter on a row opens it", press("Enter", { targetTag: "li" }), "open");
eq("Escape from the search box is the input's to handle", press("Escape", { targetTag: "input" }), null);

console.log("\nhelp");
eq("every help entry has at least one key", TRIAGE_SHORTCUTS.every((s) => s.keys.length > 0), true);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall triage-key checks passed");
process.exit(0);
