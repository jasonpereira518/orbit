/**
 * Pins the opportunity vocabulary and the repair layer in front of it.
 *
 * The kinds are a plain `text` column with no CHECK, so nothing in the database stops a bad
 * value being written and nothing in the type system stops an older client reading a newer
 * one. Both directions have to degrade rather than throw, and this is where that is proved.
 *
 * Run: npx tsx scripts/smoke-opportunity-taxonomy.ts
 */

import {
  OPPORTUNITY_KINDS,
  OPPORTUNITY_STATUSES,
  OPEN_OPPORTUNITY_STATUSES,
  JOB_SIGNAL_KINDS,
  isOpportunityKind,
  isOpenOpportunityStatus,
  looksLikeReferral,
  normalizeOpportunityDirection,
  normalizeOpportunityKind,
  normalizeOpportunityLabel,
  normalizeOpportunityStatus,
  opportunityKindLabel,
  opportunityMirrorLabels,
  opportunityStatusLabel,
  MAX_OPPORTUNITY_LABEL_CHARS,
} from "../src/lib/opportunity-kinds";
import type { OpportunityKind } from "../src/db/schema";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

console.log("\nvocabulary");

// 1. The list is exhaustive over the union and internally consistent. The `satisfies` in the
//    module proves each VALUE is a member; this proves no member was left out of the list,
//    which the type system cannot see.
{
  const values = OPPORTUNITY_KINDS.map((k) => k.value);
  const everyKind: OpportunityKind[] = [
    "internship",
    "job",
    "referral",
    "introduction",
    "startup_lead",
    "mentor",
    "investor",
    "speaker",
    "customer",
    "collaboration",
    "advice",
    "other",
  ];
  check("every union member appears in OPPORTUNITY_KINDS", everyKind.every((k) => values.includes(k)));
  check("  and nothing extra", values.length === everyKind.length, `${values.length}`);
  check("  values are unique", new Set(values).size === values.length);
  check("  labels are unique", new Set(OPPORTUNITY_KINDS.map((k) => k.label)).size === values.length);
  check("  every kind has a hint", OPPORTUNITY_KINDS.every((k) => k.hint.trim().length > 0));
}

// 2. Statuses, and the open subset the mirror and the job matcher both read.
{
  const values = OPPORTUNITY_STATUSES.map((s) => s.value);
  check("statuses are unique", new Set(values).size === values.length);
  check("  open subset is a subset", OPEN_OPPORTUNITY_STATUSES.every((s) => values.includes(s)));
  check("  'open' is open", isOpenOpportunityStatus("open"));
  check("  'in_progress' is open", isOpenOpportunityStatus("in_progress"));
  check("  'landed' is not open", !isOpenOpportunityStatus("landed"));
  check("  'dismissed' is not open", !isOpenOpportunityStatus("dismissed"));
  check("  an unknown status is not open", !isOpenOpportunityStatus("banana"));
  check("job signal kinds are real kinds", JOB_SIGNAL_KINDS.every((k) => isOpportunityKind(k)));
}

console.log("\nrepairing model output");

// 3. Aliases. Each provider has its own favourite synonym, and mapping on read is cheaper
//    than a stricter prompt plus a retry.
{
  const cases: Array<[string, OpportunityKind]> = [
    ["intro", "introduction"],
    ["Warm Intro", "introduction"],
    ["job_referral", "referral"],
    ["full-time", "job"],
    ["New Grad", "job"],
    ["co-op", "internship"],
    ["summer internship", "internship"],
    ["mentorship", "mentor"],
    ["VC", "investor"],
    ["podcast", "speaker"],
    ["design partner", "customer"],
    ["partnership", "collaboration"],
    ["cofounder", "startup_lead"],
    ["guidance", "advice"],
  ];
  for (const [input, expected] of cases) {
    check(`  "${input}" -> ${expected}`, normalizeOpportunityKind(input) === expected, normalizeOpportunityKind(input));
  }
  check("an exact kind passes through", normalizeOpportunityKind("internship") === "internship");
}

// 4. Degradation. An unknown kind must never throw and never blank a row — this is
//    user-visible data, and a kind added in one deploy will reach a client running the last.
{
  check("unknown kind -> other", normalizeOpportunityKind("board_seat") === "other");
  check("null kind -> other", normalizeOpportunityKind(null) === "other");
  check("empty kind -> other", normalizeOpportunityKind("   ") === "other");
  check("unknown kind still has a label", opportunityKindLabel("board_seat") === "Opportunity");
  check("null kind still has a label", opportunityKindLabel(null) === "Opportunity");
  check("known kind label", opportunityKindLabel("referral") === "Referral");
  check("unknown status -> open", normalizeOpportunityStatus("frobnicated") === "open");
  check("unknown status still has a label", opportunityStatusLabel("frobnicated") === "Open");
  check("known status label", opportunityStatusLabel("in_progress") === "In progress");
  check("direction: they_offer", normalizeOpportunityDirection("they_offer") === "they_offer");
  check("direction: unknown -> null", normalizeOpportunityDirection("maybe") === null);
  check("direction: null -> null", normalizeOpportunityDirection(null) === null);
}

// 5. Labels are bounded and whitespace-collapsed at the boundary, not at render time.
{
  check("label collapses whitespace", normalizeOpportunityLabel("  a   b \n c ") === "a b c");
  const long = "x".repeat(MAX_OPPORTUNITY_LABEL_CHARS + 50);
  check("label is capped", normalizeOpportunityLabel(long).length === MAX_OPPORTUNITY_LABEL_CHARS);
  check("null label -> empty", normalizeOpportunityLabel(null) === "");
}

console.log("\nthe contacts.opportunities mirror");

// 6. The mirror is what four pre-existing readers see: conversation starters, the contact
//    embedding, the extension panel, and the admin view. It carries the KIND, because a bare
//    label loses the one thing the typed table added.
{
  const labels = opportunityMirrorLabels([
    { kind: "referral", label: "could forward my resume", status: "open" },
    { kind: "internship", label: "summer infra internship", status: "in_progress" },
  ]);
  check("one line per live opportunity", labels.length === 2, JSON.stringify(labels));
  check("  kind is prefixed", labels[0] === "Referral — could forward my resume", labels[0]);
  check("  in_progress is included", labels[1]?.startsWith("Internship — "), labels[1]);
}

// 7. Closed opportunities are excluded. A mirror of dead threads would make conversation
//    starters suggest one, which is worse than saying nothing at all.
{
  const labels = opportunityMirrorLabels([
    { kind: "referral", label: "could forward my resume", status: "landed" },
    { kind: "job", label: "backend role", status: "passed" },
    { kind: "mentor", label: "monthly guidance", status: "dismissed" },
    { kind: "advice", label: "how to price the pilot", status: "open" },
  ]);
  check("closed statuses are dropped", labels.length === 1, JSON.stringify(labels));
  check("  only the open one survives", labels[0]?.startsWith("Advice — "), labels[0]);
}

// 8. Duplicates collapse, and an unlabelled row contributes nothing.
{
  const labels = opportunityMirrorLabels([
    { kind: "referral", label: "could forward my resume", status: "open" },
    { kind: "referral", label: "Could Forward My Resume", status: "open" },
    { kind: "referral", label: "   ", status: "open" },
  ]);
  check("case-insensitive dedupe", labels.length === 1, JSON.stringify(labels));
}

// 9. An unknown kind read back out of the database still produces a usable mirror line.
{
  const labels = opportunityMirrorLabels([
    { kind: "board_seat", label: "join the advisory board", status: "open" },
  ]);
  check("unknown kind mirrors as Opportunity", labels[0] === "Opportunity — join the advisory board", labels[0]);
}

console.log("\nreferral language, decided in TypeScript rather than by the model");

// Which rows carry the referral label cannot depend on which provider answered: this is the
// search people come back to Orbit specifically to run. Everything here is an OFFER.
{
  const yes = [
    "she can give me a referral",
    "offered a referral",
    "happy to refer me",
    "he'll refer you internally",
    "said she would refer me for the role",
    "will forward my resume to the infra team",
    "can pass my resume along",
    "offered to send my resume to her manager",
    "will push my resume through",
    "said she'd put my name forward",
    "will put in a good word",
    "happy to vouch for me",
    "offered to recommend me",
    "can get me in front of the team",
    // The case that would otherwise be filed as an introduction.
    "she will find the hiring manager",
    "he said he'd find the hiring manager for that team",
    "will connect me with the hiring manager",
    "knows the recruiter for that req and will reach out",
    "offered to introduce me to their recruiter",
    "will put me in touch with the hiring manager",
  ];
  for (const text of yes) {
    check(`  "${text}" is a referral`, looksLikeReferral(text));
  }
}

// The over-matching this has to avoid. A referral flag on a note that offered nothing is
// worse than no flag at all: it makes the search that matters untrustworthy.
{
  const no = [
    "referring to the API docs she mentioned",
    "referred to as the platform team internally",
    "in reference to the pricing thread",
    // A job title is a fact about them, not an offer to you.
    "she is a hiring manager at Stripe",
    "he was a recruiter before switching to product",
    "talked about resume formatting tips",
    "wants feedback on my resume",
    "mentioned the team is hiring",
  ];
  for (const text of no) {
    check(`  "${text}" is NOT a referral`, !looksLikeReferral(text), "over-matched");
  }
}

// The offer usually lives in the sentence, not in the compressed label — so both are read.
{
  check(
    "label and excerpt are read together",
    looksLikeReferral("summer infra internship", "she said she would refer me for it")
  );
  check("empty input is not a referral", !looksLikeReferral("", null, undefined));
}

console.log("\nAll opportunity taxonomy checks passed.");
