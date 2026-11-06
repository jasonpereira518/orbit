/**
 * Pins the answer labeller in `src/lib/chat-abstention.ts` — the classifier behind the
 * abstention rate on /admin/product. A phrase that mislabels real answers is fixed here.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-abstention.ts
 */
import "./smoke/_env";
import { ABSTAIN_PHRASES, labelAnswer, type AnswerOutcome } from "../src/lib/chat-abstention";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const cases: Array<{ label: string; answer: string; cited?: number; expect: AnswerOutcome }> = [
  {
    label: "a grounded answer is answered",
    answer: "You know two people at Stripe: Maya Chen and Omar Ali. [e1]",
    cited: 1,
    expect: "answered",
  },
  {
    label: "an ungrounded answer with no abstain phrase is answered",
    answer: "Maya's email is maya@stripe.example.",
    expect: "answered",
  },
  {
    label: "'nobody is overdue' is a real answer, not an abstention",
    answer: "Nobody is overdue right now, and your outreach queue is clear.",
    expect: "answered",
  },
  {
    label: "a flat 'I don't know' is abstained",
    answer: "I don't know who Maya reports to. You could add it to her notes.",
    expect: "abstained",
  },
  {
    label: "curly apostrophes are matched",
    answer: "I don’t have anything on the Series A in your notes.",
    expect: "abstained",
  },
  {
    label: "'Nothing in your notes…' is abstained",
    answer: "Nothing in your notes mentions the Series A.",
    expect: "abstained",
  },
  {
    label: "an abstain phrase in the second sentence still counts",
    answer: "Good question. I couldn't find any meeting with Omar last week.",
    expect: "abstained",
  },
  {
    label: "an abstention that still cites something is partial",
    answer: "I don't know Maya's email, but she's at Stripe and you met at AWS Summit. [e2]",
    cited: 1,
    expect: "partial",
  },
  {
    label: "an abstention beside a people block is partial",
    answer: "I don't see anyone at Ramp, but these two know people there:\n::people[c1,c2]\n",
    expect: "partial",
  },
  {
    label: "an abstention beside a list block is partial",
    answer: "Here is everyone at Stripe.\n::list[r1]\nI couldn't find when you last spoke to Omar.",
    expect: "partial",
  },
  {
    label: "an ungrounded answer that says what it is missing at the end is partial",
    answer:
      "You have three reminders this week. The first is to call Sam on Friday. The second is the Stripe intro. The third is unrelated. I couldn't find a due date for the last one.",
    expect: "partial",
  },
  {
    label: "a citation marker alone does not hide an abstain phrase",
    answer: "Your notes don't say who introduced you. [e3]",
    cited: 1,
    expect: "partial",
  },
];

console.log("Labelling answers...");
for (const c of cases) {
  const got = labelAnswer(c.answer, { citedCount: c.cited ?? 0 });
  check(c.label, got === c.expect, `expected ${c.expect}, got ${got}`);
}

console.log("The phrase list...");
check(
  "is lower-case with straight apostrophes, so normalised answers can match it",
  ABSTAIN_PHRASES.every((p) => p === p.toLowerCase() && !/[‘’]/.test(p))
);
check(
  "never contains 'no one', 'nobody' or 'none' — those are real answers from complete sections",
  !ABSTAIN_PHRASES.some((p) => /\b(no one|nobody|none)\b/.test(p))
);

if (failures) {
  console.error(`\n${failures} chat-abstention check(s) failed.`);
  process.exit(1);
}
console.log("\nAll chat-abstention checks passed.");
process.exit(0);
