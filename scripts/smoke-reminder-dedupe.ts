/**
 * A window reminder (an action item or fallback follow-up, dated by Orbit's default) yields
 * to a dated commitment for the same person that says the same thing. Fixture: the
 * 2026-09-15 audit, where "Follow up with Priya next week about the PM role" became two
 * reminders, Sep 21 (from "next week") and Sep 29 (the action item). Pure.
 * Run: npx tsx scripts/smoke-reminder-dedupe.ts
 */
import { dropSupersededWindowDrafts, titlesNearDuplicate } from "../src/lib/note-batches";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

type Draft = { contact: string | null; title: string; dueDate: Date; dateBasis: "absolute" | "relative" | "vague" | "window" };
const noon = (month: number, day: number) => new Date(2026, month - 1, day, 12, 0, 0, 0);
const kept = (drafts: Draft[]) => dropSupersededWindowDrafts(drafts, (d) => d.contact).map((d) => d.title);

const priyaDated: Draft = { contact: "priya", title: "Follow up with Priya about the PM role", dueDate: noon(9, 21), dateBasis: "relative" };
const priyaAction: Draft = { contact: "priya", title: "Follow up with Priya next week about the PM role", dueDate: noon(9, 29), dateBasis: "window" };
const sarahAction: Draft = { contact: "sarah", title: "Send Sarah the retrieval write-up", dueDate: noon(9, 29), dateBasis: "window" };

console.log("titlesNearDuplicate…");
check("same follow-up, one mentions 'next week'", titlesNearDuplicate(priyaDated.title, priyaAction.title));
check("substring titles still collide", titlesNearDuplicate("Kickoff", "Book kickoff"));
check("different actions for one person do not", !titlesNearDuplicate("Follow up with Priya", "Send Priya the deck"));
check("unrelated titles do not", !titlesNearDuplicate("Send Sarah the retrieval write-up", "Intro to Devon, Sarah's colleague"));
check("empty titles never collide", !titlesNearDuplicate("", "the"));

console.log("\ndropSupersededWindowDrafts…");
check(
  "the audit pair keeps only the dated reminder",
  JSON.stringify(kept([priyaDated, priyaAction, sarahAction])) === JSON.stringify([priyaDated.title, sarahAction.title]),
  JSON.stringify(kept([priyaDated, priyaAction, sarahAction]))
);
check(
  "another person's window draft is untouched",
  kept([priyaDated, { ...priyaAction, contact: "sarah" }]).length === 2
);
check(
  "a dated commitment exactly 7 days after the window still supersedes it",
  kept([{ ...priyaDated, dueDate: noon(10, 6) }, priyaAction]).length === 1
);
check(
  "one 8 days after does not",
  kept([{ ...priyaDated, dueDate: noon(10, 7) }, priyaAction]).length === 2
);
check(
  "two window drafts never supersede each other",
  kept([priyaAction, { ...priyaAction, title: "Follow up with Priya about the PM role" }]).length === 2
);
check(
  "the old rule's case still holds (Kickoff Sep 16 vs Book kickoff window Sep 15)",
  JSON.stringify(
    kept([
      { contact: "dev", title: "Kickoff", dueDate: noon(9, 16), dateBasis: "absolute" },
      { contact: "dev", title: "Book kickoff", dueDate: noon(9, 15), dateBasis: "window" },
    ])
  ) === JSON.stringify(["Kickoff"])
);

if (failures) {
  console.error(`\nsmoke-reminder-dedupe: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-reminder-dedupe: ok");
process.exit(0);
