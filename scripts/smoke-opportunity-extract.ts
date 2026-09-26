/**
 * The opportunity validation layer, with no network calls.
 *
 * The thing being pinned is that the PROMPT IS ONLY A FILTER: a model can claim any
 * opportunity it likes, and what decides whether we store it is verbatim containment plus
 * deterministic date resolution, here, in TypeScript — so all three providers behave
 * identically.
 *
 * Run: npx tsx scripts/smoke-opportunity-extract.ts
 */

import {
  opportunityListSchema,
  parsedOpportunitySchema,
  type ParsedOpportunity,
} from "../src/lib/ai-opportunity-schema";
import {
  MAX_OPPORTUNITIES_PER_PERSON,
  validateOpportunities,
} from "../src/lib/opportunity-extract";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

function isoDay(d: Date | null) {
  if (!d) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function raw(over: Partial<ParsedOpportunity>): ParsedOpportunity {
  return parsedOpportunitySchema.parse({
    kind: "internship",
    label: "summer infra internship",
    direction: "they_offer",
    due_phrase: null,
    source_excerpt: "they open summer internship applications in October",
    confidence: 0.9,
    ...over,
  });
}

const NOTES =
  "Coffee with Maya. She said they open summer internship applications in October, " +
  "and she offered to forward my resume to the infra team. Also mentioned the deadline is Oct 15.";
const AUG = new Date(2026, 7, 16, 12, 0, 0, 0); // 2026-08-16
const OPTS = { today: AUG, anchor: AUG };

console.log("\ncontainment is the guard that matters");

// 1. A plausible-sounding opportunity nobody said is dropped. This is the whole defence
//    against a confident hallucination, and it is the only rule here that cannot be relaxed.
{
  const r = validateOpportunities(
    [raw({ source_excerpt: "she promised me a full-time offer on the spot" })],
    NOTES,
    OPTS
  );
  check("unverifiable excerpt is rejected", r.opportunities.length === 0);
  check("  and counted", r.rejected.unverifiable === 1, JSON.stringify(r.rejected));
}

// 2. An empty excerpt is NOT containment-satisfying. `"".includes` would wave every such
//    item through, which is precisely backwards.
{
  const r = validateOpportunities([raw({ source_excerpt: "" })], NOTES, OPTS);
  check("empty excerpt is rejected", r.opportunities.length === 0);
  check("  and counted as unverifiable", r.rejected.unverifiable === 1);
}

// 3. Containment is whitespace- and case-insensitive but NOT punctuation-insensitive: an
//    excerpt that differs by more than spacing is a paraphrase, which is what we reject.
{
  const r = validateOpportunities(
    [raw({ source_excerpt: "They  Open   SUMMER internship\napplications in October" })],
    NOTES,
    OPTS
  );
  check("whitespace/case differences still match", r.opportunities.length === 1, JSON.stringify(r.rejected));
}

console.log("\nkinds are re-derived, never trusted");

{
  const r = validateOpportunities([raw({ kind: "warm_intro" })], NOTES, OPTS);
  check("an alias is repaired", r.opportunities[0]?.kind === "introduction", r.opportunities[0]?.kind);
}
{
  const r = validateOpportunities([raw({ kind: "board_seat" })], NOTES, OPTS);
  check("an unknown kind becomes other, not a rejection", r.opportunities[0]?.kind === "other");
}

console.log("\nreferral language overrides whatever the model called it");

// The model says "introduction"; the note says she will find the hiring manager. Referral
// wins, because that is the word the user will search for months later.
{
  const notes = "Coffee with Maya. She said she would find the hiring manager for that team.";
  const r = validateOpportunities(
    [
      raw({
        kind: "introduction",
        label: "intro to the hiring manager",
        source_excerpt: "She said she would find the hiring manager for that team.",
      }),
    ],
    notes,
    OPTS
  );
  check("model said introduction", r.opportunities.length === 1, JSON.stringify(r.rejected));
  check("  stored as referral", r.opportunities[0]?.kind === "referral", r.opportunities[0]?.kind);
}

// "she can refer me for the internship" is BOTH. Referral is the actionable half, and the
// label keeps "internship" so a search for that still finds the row.
{
  const notes = "Maya can refer me for the summer infra internship.";
  const r = validateOpportunities(
    [
      raw({
        kind: "internship",
        label: "summer infra internship",
        source_excerpt: "Maya can refer me for the summer infra internship.",
      }),
    ],
    notes,
    OPTS
  );
  check("model said internship", r.opportunities.length === 1);
  check("  stored as referral", r.opportunities[0]?.kind === "referral", r.opportunities[0]?.kind);
  check(
    "  and the label still says internship, so that search still hits",
    r.opportunities[0]?.label.includes("internship"),
    r.opportunities[0]?.label
  );
}

// No referral language: the model's kind stands.
{
  const r = validateOpportunities(
    [raw({ kind: "internship", label: "summer infra internship" })],
    NOTES,
    OPTS
  );
  check("without referral language the model's kind stands", r.opportunities[0]?.kind === "internship", r.opportunities[0]?.kind);
}

console.log("\ndates: resolved here, and never fatal");

// 4. THE RULE THAT DIFFERS FROM COMMITMENTS. A commitment with an unresolvable date is not a
//    reminder and is rejected. An opportunity with an unresolvable date is still an
//    opportunity — "she can refer me" survives whether or not anyone named a deadline.
{
  const r = validateOpportunities([raw({ due_phrase: "at some point in the future maybe" })], NOTES, OPTS);
  check("unresolvable date keeps the opportunity", r.opportunities.length === 1, JSON.stringify(r.rejected));
  check("  with dueDate null", r.opportunities[0]?.dueDate === null);
  check("  and the phrase preserved", r.opportunities[0]?.rawDatePhrase === "at some point in the future maybe");
}
{
  const r = validateOpportunities([raw({ due_phrase: null })], NOTES, OPTS);
  check("no date phrase at all is fine", r.opportunities.length === 1);
  check("  dueDate null, rawDatePhrase null", r.opportunities[0]?.dueDate === null && r.opportunities[0]?.rawDatePhrase === null);
}

// 5. A yearless absolute date resolves to the next FUTURE occurrence.
{
  const r = validateOpportunities([raw({ due_phrase: "Oct 15" })], NOTES, OPTS);
  check("Oct 15 from August -> same year", isoDay(r.opportunities[0]?.dueDate ?? null) === "2026-10-15", String(isoDay(r.opportunities[0]?.dueDate ?? null)));
}
{
  const DEC = new Date(2026, 11, 20, 12, 0, 0, 0);
  const r = validateOpportunities([raw({ due_phrase: "Oct 15" })], NOTES, { today: DEC, anchor: DEC });
  check("Oct 15 from December -> next year", isoDay(r.opportunities[0]?.dueDate ?? null) === "2027-10-15", String(isoDay(r.opportunities[0]?.dueDate ?? null)));
}

// 6. A date that has already passed loses the DATE, not the opportunity.
{
  const r = validateOpportunities([raw({ due_phrase: "2026-01-05" })], NOTES, OPTS);
  check("a stated past date is dropped", r.opportunities.length === 1, JSON.stringify(r.rejected));
  check("  but only the date", r.opportunities[0]?.dueDate === null);
}

// 7. A relative phrase resolves against the anchor, which is the date of the CONVERSATION,
//    not today — the same rule the commitments module follows.
{
  const r = validateOpportunities([raw({ due_phrase: "in two weeks" })], NOTES, OPTS);
  check("relative phrase resolves off the anchor", isoDay(r.opportunities[0]?.dueDate ?? null) === "2026-08-30", String(isoDay(r.opportunities[0]?.dueDate ?? null)));
}

console.log("\ndedupe and caps");

{
  const r = validateOpportunities([raw({}), raw({ label: "Summer  Infra   Internship" })], NOTES, OPTS);
  check("same kind+label collapses", r.opportunities.length === 1, JSON.stringify(r.rejected));
  check("  and is counted", r.rejected.duplicate === 1);
}
{
  const r = validateOpportunities([raw({ kind: "internship" }), raw({ kind: "referral" })], NOTES, OPTS);
  check("same label under a different kind is kept", r.opportunities.length === 2);
}
{
  const many = Array.from({ length: MAX_OPPORTUNITIES_PER_PERSON + 3 }, (_, i) =>
    raw({ label: `opportunity number ${i}` })
  );
  const r = validateOpportunities(many, NOTES, OPTS);
  check(`capped at ${MAX_OPPORTUNITIES_PER_PERSON}`, r.opportunities.length === MAX_OPPORTUNITIES_PER_PERSON);
  check("  overflow counted", r.rejected.capped === 3, JSON.stringify(r.rejected));
}
{
  const r = validateOpportunities([raw({ label: "   " })], NOTES, OPTS);
  check("an empty label is rejected before containment", r.rejected.empty === 1 && r.rejected.unverifiable === 0);
}

console.log("\nthe legacy bare-string shape still parses");

// 8. THE FAILURE THIS PREVENTS: `opportunities` was `string[]` before this change, and a
//    terse model still emits that. Zod rejects the whole object on one bad member, and this
//    field sits inside `people[]` — so throwing here would lose EVERY PERSON in the
//    response, not one field.
{
  const parsed = opportunityListSchema.parse(["intro to Raj", "referral at Stripe"]);
  check("bare strings parse", parsed.length === 2, JSON.stringify(parsed));
  check("  kind is left for normalisation", parsed[0].kind === null);
  check("  and they carry no excerpt", parsed[0].source_excerpt === "");
  // ...which means containment drops them. That is correct: a legacy string carries no
  // evidence it was ever said. The point of accepting the shape is not losing the response.
  const r = validateOpportunities(parsed, NOTES, OPTS);
  check("  so validation drops them", r.opportunities.length === 0 && r.rejected.unverifiable === 2);
}
{
  const mixed = opportunityListSchema.parse([
    "intro to Raj",
    { kind: "referral", label: "forward my resume", source_excerpt: "offered to forward my resume", confidence: 0.8 },
  ]);
  check("mixed shapes parse together", mixed.length === 2);
  check("  the typed one keeps its excerpt", mixed[1].source_excerpt === "offered to forward my resume");
}
{
  check("null list parses to empty", opportunityListSchema.parse(null).length === 0);
  check("missing list parses to empty", opportunityListSchema.parse(undefined).length === 0);
  check("empty labels are dropped", opportunityListSchema.parse(["  ", "real one"]).length === 1);
}

console.log("\nAll opportunity extraction checks passed.");
