/**
 * The capture review's "Skipped …" line quotes only phrases that are really in the note.
 * It used to print a hard-coded example ("in a fortnight") whatever the note said. Fixture:
 * the note from the 2026-09-15 audit. Pure: no database, no network.
 * Run: npx tsx scripts/smoke-capture-skipped-phrases.ts
 */
import { validateCommitments, type RawCommitmentItem } from "../src/lib/date-commitment-extract";
import { skippedNoteText } from "../src/lib/capture/skipped-note";

const NOTE =
  "Founders dinner in Durham last night. Sat next to Priya Raman, who runs growth at Loom and used to be at Stripe with Tom. She's hiring a PM and offered to intro me to their head of partnerships. Also met Sarah Chen again (OpenAI) - she wants the retrieval write-up by Friday and mentioned her colleague Devon is working on evals. Devon didn't give a last name. Follow up with Priya next week about the PM role.";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function item(over: Partial<RawCommitmentItem>): RawCommitmentItem {
  return {
    title: "x",
    detail: null,
    raw_date_phrase: "x",
    date: "",
    date_kind: "relative",
    year_stated: false,
    person_name: null,
    kind: null,
    confidence: 0.8,
    source_excerpt: "",
    ...over,
  };
}

// Tuesday 2026-09-15, 09:00 local — the audit's capture day.
const TODAY = new Date(2026, 8, 15, 9, 0, 0, 0);

const r = validateCommitments(
  [
    item({ title: "Follow up with Priya about the PM role", raw_date_phrase: "next week", person_name: "Priya Raman" }),
    item({ title: "Send Sarah the retrieval write-up", raw_date_phrase: "by Friday", person_name: "Sarah Chen" }),
    // What a model might invent: not in the note at all.
    item({ title: "Check in with Devon", raw_date_phrase: "in a fortnight", person_name: "Devon" }),
    // The same unrecognized phrase again, differently cased: reported once, as the note spells it.
    item({ title: "Retrieval write-up", raw_date_phrase: "BY FRIDAY", person_name: "Sarah Chen" }),
  ],
  NOTE,
  { today: TODAY, anchor: TODAY }
);

console.log("validateCommitments…");
check("'next week' resolves to one reminder", r.commitments.length === 1 && r.commitments[0].rawDatePhrase === "next week", JSON.stringify(r.commitments.map((c) => c.rawDatePhrase)));
check("both 'by Friday' items count as unrecognized", r.rejected.relative === 2, JSON.stringify(r.rejected));
check("the invented phrase counts as unverifiable", r.rejected.unverifiable === 1, JSON.stringify(r.rejected));
check(
  "unrecognized phrases are recorded once, spelled as the note spells them",
  JSON.stringify(r.rejected.relativePhrases) === JSON.stringify(["by Friday"]),
  JSON.stringify(r.rejected.relativePhrases)
);
check("the invented phrase is never recorded", !(r.rejected.relativePhrases ?? []).some((p) => /fortnight/i.test(p)));

console.log("\nskippedNoteText…");
const text = skippedNoteText(r.rejected);
check(
  "the summary quotes the real phrase",
  text === "Skipped 2 unrecognized phrases (“by Friday”), 1 unverified. Orbit only schedules dates it can verify or resolve with confidence.",
  String(text)
);
check("the summary never names a phrase the note does not contain", !/fortnight/i.test(text ?? ""));
check(
  "an older job with counts but no phrases gets no example",
  skippedNoteText({ relative: 1, unverifiable: 0, past: 0 }) ===
    "Skipped 1 unrecognized phrase. Orbit only schedules dates it can verify or resolve with confidence."
);
check("nothing skipped means no line", skippedNoteText({ relative: 0, unverifiable: 0, past: 0, relativePhrases: [] }) === null);
check("null means no line", skippedNoteText(null) === null);
check(
  "at most three phrases are quoted",
  (skippedNoteText({ relative: 4, unverifiable: 0, past: 0, relativePhrases: ["a", "b", "c", "d"] }) ?? "").split("“").length - 1 === 3
);

if (failures) {
  console.error(`\nsmoke-capture-skipped-phrases: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-capture-skipped-phrases: ok");
process.exit(0);
