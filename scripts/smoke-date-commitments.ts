/**
 * Exercises the absolute-dates-only validation layer with no network calls.
 * Run: npx tsx scripts/smoke-date-commitments.ts
 */

import {
  datedCommitmentsSchema,
  validateCommitments,
  type RawCommitmentItem,
} from "../src/lib/date-commitment-extract";

function item(over: Partial<RawCommitmentItem>): RawCommitmentItem {
  return {
    title: "Project kickoff",
    detail: null,
    raw_date_phrase: "Sept 2",
    date: "2026-09-02",
    date_kind: null,
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
  const r = validateCommitments([item({})], notes, { today: AUG });
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
    { today: DEC }
  );
  check("Dec 20 + 'Jan 8' survives", r.commitments.length === 1);
  const got = isoDay(r.commitments[0].dueDate);
  check("  rolls to 2027, not 2026", got === "2027-01-08", got);
}

// 3. Relative phrases the grammar knows now RESOLVE (against today, absent an anchor)
//    instead of being discarded. See cases 13-18 below for anchor-driven resolution.
{
  const notes = "We should catch up again next Tuesday.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "next Tuesday", date: "" })],
    notes,
    { today: AUG }
  );
  check("'next Tuesday' resolves", r.commitments.length === 1, JSON.stringify(r.rejected));
  check("  Sun Aug 16 -> Tue Aug 18", isoDay(r.commitments[0]?.dueDate) === "2026-08-18", isoDay(r.commitments[0]?.dueDate));
  check("  basis relative", r.commitments[0]?.dateBasis === "relative");
}
{
  const notes = "I'll ping Marcus in two weeks.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "in two weeks", date: "" })],
    notes,
    { today: AUG }
  );
  check("'in two weeks' resolves", r.commitments.length === 1, JSON.stringify(r.rejected));
  check("  Aug 16 + 14d -> Aug 30", isoDay(r.commitments[0]?.dueDate) === "2026-08-30", isoDay(r.commitments[0]?.dueDate));
}
// An unresolvable relative phrase is still rejected as relative.
{
  const notes = "We should catch up again last Tuesday.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "last Tuesday", date: "" })],
    notes,
    { today: AUG }
  );
  check("'last Tuesday' still rejected (grammar looks forward only)", r.commitments.length === 0 && r.rejected.relative === 1, JSON.stringify(r.rejected));
}

// 4. A phrase the model invented (absent from the note) is rejected.
{
  const notes = "Nothing scheduled with her yet.";
  const r = validateCommitments(
    [item({ raw_date_phrase: "December 1", date: "2026-12-01" })],
    notes,
    { today: AUG }
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
    { today: AUG }
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
    { today: AUG }
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
    { today: AUG }
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
    { today: AUG }
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
    { today: AUG }
  );
  check("bare day-of-month rejected", r.commitments.length === 0);
}

// 10. Duplicates within one batch collapse.
{
  const notes = "AWS re:Invent Dec 1. Also re:Invent Dec 1, don't forget.";
  const dup = item({ title: "AWS re:Invent", raw_date_phrase: "Dec 1", date: "2026-12-01" });
  const r = validateCommitments([dup, { ...dup }], notes, { today: AUG });
  check("duplicate collapsed to one", r.commitments.length === 1);
}

// 11. Model-supplied kind is honored; an unknown kind falls back to inference.
{
  const notes = "AWS re:Invent Dec 1.";
  const r = validateCommitments(
    [item({ title: "AWS re:Invent", raw_date_phrase: "Dec 1", date: "2026-12-01", kind: "meet" })],
    notes,
    { today: AUG }
  );
  check("model kind honored", r.commitments[0].actionKind === "meet");

  const r2 = validateCommitments(
    [item({ title: "AWS re:Invent", raw_date_phrase: "Dec 1", date: "2026-12-01", kind: "nonsense" })],
    notes,
    { today: AUG }
  );
  check("bogus kind falls back", r2.commitments.length === 1);
}

// 12. Mixed realistic note: both the absolute and the resolvable relative item survive,
//     each carrying the right basis.
{
  const notes = `Coffee with Sarah Chen (OpenAI).
Kickoff is Sept 2 and she wants the integration doc before then.
We should catch up again next Tuesday, and I'll ping Marcus sometime soon.
We met on Aug 3 originally.`;
  const r = validateCommitments(
    [
      item({ raw_date_phrase: "Sept 2", date: "2026-09-02", person_name: "Sarah Chen" }),
      item({ title: "Catch up", raw_date_phrase: "next Tuesday", date: "" }),
    ],
    notes,
    { today: AUG }
  );
  check("mixed note keeps both items", r.commitments.length === 2, String(r.commitments.length));
  check("  absolute item carries the person", r.commitments[0].personName === "Sarah Chen");
  check("  absolute basis", r.commitments[0].dateBasis === "absolute");
  check("  relative basis", r.commitments[1].dateBasis === "relative");
}

// 13. Relative phrases resolve against the ANCHOR (the note's date), not today.
{
  const anchor = new Date(2026, 8, 1, 12); // Tue Sept 1 — the meeting date found in the notes
  const today = new Date(2026, 8, 3, 12);  // pasted two days later
  const notes = "Great chat with Sarah. She'll send the deck in two weeks and we meet next Friday.";
  const r = validateCommitments(
    [
      item({ title: "Send deck", raw_date_phrase: "in two weeks", date: "" }),
      item({ title: "Meet Sarah", raw_date_phrase: "next Friday", date: "" }),
    ],
    notes,
    { today, anchor }
  );
  check("relative: two commitments resolved", r.commitments.length === 2, String(r.commitments.length));
  check("  'in two weeks' from Sept 1 → Sept 15", isoDay(r.commitments[0].dueDate) === "2026-09-15", isoDay(r.commitments[0].dueDate));
  check("  'next Friday' from Sept 1 → Sept 4", isoDay(r.commitments[1].dueDate) === "2026-09-04", isoDay(r.commitments[1].dueDate));
  check("  basis relative", r.commitments[0].dateBasis === "relative");
  check("  anchorIso recorded", r.commitments[0].anchorIso === "2026-09-01", r.commitments[0].anchorIso);
  check("  rejected.relative is 0", r.rejected.relative === 0);
}

// 14. A relative phrase that already passed by TODAY is skipped as past, even if it was
//     in the future relative to the anchor.
{
  const anchor = new Date(2026, 8, 1, 12);
  const today = new Date(2026, 8, 10, 12);
  const notes = "Ping him tomorrow about the intro.";
  const r = validateCommitments([item({ title: "Ping about intro", raw_date_phrase: "tomorrow", date: "" })], notes, { today, anchor });
  check("late upload: 'tomorrow' from Sept 1 is past on Sept 10", r.commitments.length === 0 && r.rejected.past === 1, JSON.stringify(r.rejected));
}

// 15. Vague phrasing lands on the default window with basis "vague".
{
  const anchor = new Date(2026, 8, 1, 12);
  const notes = "Should grab coffee soon.";
  const r = validateCommitments([item({ title: "Grab coffee", raw_date_phrase: "soon", date: "" })], notes, { today: anchor, anchor });
  check("vague 'soon' → anchor + 14d", isoDay(r.commitments[0]?.dueDate) === "2026-09-15", isoDay(r.commitments[0]?.dueDate));
  check("  basis vague", r.commitments[0]?.dateBasis === "vague");
}

// 16. A relative phrase the grammar does not know is still rejected as relative.
{
  const anchor = new Date(2026, 8, 1, 12);
  const notes = "Let's sync in a fortnight or so.";
  const r = validateCommitments([item({ title: "Sync", raw_date_phrase: "in a fortnight", date: "" })], notes, { today: anchor, anchor });
  check("unknown relative phrase rejected", r.commitments.length === 0 && r.rejected.relative === 1, JSON.stringify(r.rejected));
}

// 17. Absolute dates still resolve exactly as before and carry basis "absolute" + anchor.
{
  const anchor = new Date(2026, 8, 1, 12);
  const notes = "Kickoff is Sept 20.";
  const r = validateCommitments([item({ title: "Kickoff", raw_date_phrase: "Sept 20", date: "2026-09-20" })], notes, { today: anchor, anchor });
  check("absolute basis", r.commitments[0]?.dateBasis === "absolute" && r.commitments[0]?.anchorIso === "2026-09-01");
}

// 18. Without an anchor, today is the anchor.
{
  const today = new Date(2026, 8, 1, 12);
  const r = validateCommitments([item({ title: "Ping", raw_date_phrase: "tomorrow", date: "" })], "Ping tomorrow.", { today });
  check("no anchor → today", isoDay(r.commitments[0]?.dueDate) === "2026-09-02", isoDay(r.commitments[0]?.dueDate));
}

// 19. The model omits `date` entirely for a relative phrase — which the prompt tells it to
//     do. A required `z.string()` there threw inside the schema and lost EVERY commitment
//     in the response, not just this one. Parse the RAW payload, not a fixture, so this
//     exercises the zod layer.
{
  const anchor = new Date(2026, 8, 1, 12);
  const raw = {
    commitments: [
      {
        title: "Intro to Raj",
        detail: null,
        raw_date_phrase: "in two weeks",
        // no `date` key at all
        date_kind: "relative",
        person_name: "Sarah Chen",
        confidence: 0.8,
      },
    ],
  };
  const parsed = datedCommitmentsSchema.parse(raw);
  check("missing `date` key parses", parsed.commitments.length === 1);
  check("  and defaults to empty string", parsed.commitments[0].date === "");
  const notes = "She'll intro me to Raj in two weeks.";
  const r = validateCommitments(parsed.commitments, notes, { today: anchor, anchor });
  check("  the relative phrase still resolves", r.commitments.length === 1, JSON.stringify(r.rejected));
  check("  anchor + 14d", isoDay(r.commitments[0]?.dueDate) === "2026-09-15", isoDay(r.commitments[0]?.dueDate));
  check("  basis relative", r.commitments[0]?.dateBasis === "relative");
}

console.log("\nAll date-commitment smoke checks passed.");
