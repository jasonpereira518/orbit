/**
 * Exercises the absolute-dates-only validation layer with no network calls.
 * Run: npx tsx scripts/smoke-date-commitments.ts
 */

import {
  validateCommitments,
  type RawCommitmentItem,
} from "../src/lib/date-commitment-extract";

function item(over: Partial<RawCommitmentItem>): RawCommitmentItem {
  return {
    title: "Project kickoff",
    detail: null,
    raw_date_phrase: "Sept 2",
    date: "2026-09-02",
    year_stated: false,
    person_name: null,
    kind: null,
    confidence: 0.9,
    source_excerpt: "",
    ...over,
  };
}

function isoDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

const AUG = new Date(2026, 7, 16, 12, 0, 0, 0); // 2026-08-16
const DEC = new Date(2026, 11, 20, 12, 0, 0, 0); // 2026-12-20

// 1. Yearless month/day resolves forward within the same year.
{
  const notes = "Kickoff is Sept 2 and she wants the doc before then.";
  const r = validateCommitments([item({})], notes, AUG);
  check("yearless Sept 2 -> 2026-09-02", r.commitments.length === 1);
  check(
    "  resolved date",
    isoDay(r.commitments[0].dueDate) === "2026-09-02",
    isoDay(r.commitments[0].dueDate)
  );
  check("  yearInferred set", r.commitments[0].yearInferred === true);
  check("  phrase preserved verbatim", r.commitments[0].rawDatePhrase === "Sept 2");
}

// 2. THE YEAR-BOUNDARY TRAP. Captured in December, "Jan 8" must roll to next year.
//    parseInteractionDateFromNotes would walk this backwards to 2026 and it would then
//    be silently dropped as past-dated.
{
  const notes = "Kickoff Jan 8 per the contract.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "Jan 8", date: "2027-01-08" })],
    notes,
    DEC
  );
  check("Dec 20 + 'Jan 8' survives", r.commitments.length === 1);
  const got = isoDay(r.commitments[0].dueDate);
  check("  rolls to 2027, not 2026", got === "2027-01-08", got);
}

// 3. Relative phrases are discarded.
{
  const notes = "We should catch up again next Tuesday.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "next Tuesday", date: "2026-08-18" })],
    notes,
    AUG
  );
  check("'next Tuesday' rejected", r.commitments.length === 0);
  check("  counted as relative", r.rejected.relative === 1);
}
{
  const notes = "I'll ping Marcus in two weeks.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "in two weeks", date: "2026-08-30" })],
    notes,
    AUG
  );
  check("'in two weeks' rejected", r.commitments.length === 0);
  check("  counted as relative", r.rejected.relative === 1);
}

// 4. A phrase the model invented (absent from the note) is rejected.
{
  const notes = "Nothing scheduled with her yet.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "December 1", date: "2026-12-01" })],
    notes,
    AUG
  );
  check("hallucinated phrase rejected", r.commitments.length === 0);
  check("  counted as unverifiable", r.rejected.unverifiable === 1);
}

// 5. Phrase and model ISO date must agree.
{
  const notes = "Kickoff is Sept 2.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "Sept 2", date: "2026-09-20" })],
    notes,
    AUG
  );
  check("phrase/date disagreement rejected", r.commitments.length === 0);
  check("  counted as unverifiable", r.rejected.unverifiable === 1);
}

// 6. Explicitly past-dated items are dropped, and counted so the UI can say so.
{
  const notes = "Board review Jan 5, 2025 went fine.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "Jan 5, 2025", date: "2025-01-05", year_stated: true })],
    notes,
    AUG
  );
  check("past date rejected", r.commitments.length === 0);
  check("  counted as past", r.rejected.past === 1);
}

// 7. ISO input is accepted and NOT marked inferred.
{
  const notes = "Filing due 2026-09-02.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "2026-09-02", date: "2026-09-02", year_stated: true })],
    notes,
    AUG
  );
  check("ISO phrase accepted", r.commitments.length === 1);
  check("  yearInferred false", r.commitments[0].yearInferred === false);
}

// 8. "15th of October" — day-first form with the month in the phrase.
{
  const notes = "Board review on the 15th of October.";
  const r = validateCommitments(
    [
      item({
        title: "Board review",
        raw_date_phrase: "15th of October",
        date: "2026-10-15",
      }),
    ],
    notes,
    AUG
  );
  check("day-first phrase accepted", r.commitments.length === 1);
  const got = isoDay(r.commitments[0].dueDate);
  check("  resolved date", got === "2026-10-15", got);
}

// 9. A bare day with the month elsewhere is NOT extracted — the phrase must name it.
{
  const notes = "Lots happening in September. Board review on the 15th.";
  const r = validateCommitments(
    [item({ title: "Board review", raw_date_phrase: "the 15th", date: "2026-09-15" })],
    notes,
    AUG
  );
  check("bare day-of-month rejected", r.commitments.length === 0);
}

// 10. Duplicates within one batch collapse.
{
  const notes = "AWS re:Invent Dec 1. Also re:Invent Dec 1, don't forget.";
  const dup = item({ title: "AWS re:Invent", raw_date_phrase: "Dec 1", date: "2026-12-01" });
  const r = validateCommitments([dup, { ...dup }], notes, AUG);
  check("duplicate collapsed to one", r.commitments.length === 1);
}

// 11. Model-supplied kind is honored; an unknown kind falls back to inference.
{
  const notes = "AWS re:Invent Dec 1.";
  const r = validateCommitments(
    [item({ title: "AWS re:Invent", raw_date_phrase: "Dec 1", date: "2026-12-01", kind: "meet" })],
    notes,
    AUG
  );
  check("model kind honored", r.commitments[0].actionKind === "meet");

  const r2 = validateCommitments(
    [item({ title: "AWS re:Invent", raw_date_phrase: "Dec 1", date: "2026-12-01", kind: "nonsense" })],
    notes,
    AUG
  );
  check("bogus kind falls back", r2.commitments.length === 1);
}

// 12. Mixed realistic note: exactly one absolute-dated item survives.
{
  const notes = `Coffee with Sarah Chen (OpenAI).
Kickoff is Sept 2 and she wants the integration doc before then.
We should catch up again next Tuesday, and I'll ping Marcus sometime soon.
We met on Aug 3 originally.`;
  const r = validateCommitments(
    [
      item({ raw_date_phrase: "Sept 2", date: "2026-09-02", person_name: "Sarah Chen" }),
      item({ raw_date_phrase: "next Tuesday", date: "2026-08-18" }),
    ],
    notes,
    AUG
  );
  check("mixed note keeps only the absolute date", r.commitments.length === 1);
  check("  person carried through", r.commitments[0].personName === "Sarah Chen");
}

console.log("\nAll date-commitment smoke checks passed.");
