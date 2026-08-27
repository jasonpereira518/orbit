/**
 * Guards the indexed duplicate-detection path in src/lib/duplicates.ts.
 *
 * Regression covered: the composite Map keys for byNameCompany/byNameTitle were built
 * with a different separator by the writer (addToDuplicateIndex) than by the builder and
 * reader (buildDuplicateIndex / findDuplicateCandidatesIndexed). Contacts created
 * mid-batch therefore never matched the 0.9 "name + company" or 0.85 "name + title"
 * tiers, silently under-merging within a single large import.
 */
import {
  buildDuplicateIndex,
  addToDuplicateIndex,
  findDuplicateCandidatesIndexed,
  findDuplicateCandidates,
  DUPLICATE_MERGE_CONFIDENCE,
} from "../src/lib/duplicates";
import type { Contact } from "../src/db/schema";

let n = 0;
function contact(fields: Partial<Contact>): Contact {
  return {
    id: `c${++n}`,
    userId: "u",
    fullName: null,
    email: null,
    linkedinUrl: null,
    company: null,
    title: null,
    ...fields,
  } as Contact;
}

function expectMatch(
  matches: { reason: string; confidence: number }[],
  reason: string,
  confidence: number,
  label: string
) {
  const hit = matches.find((m) => m.reason === reason);
  if (!hit) {
    throw new Error(
      `${label}: expected "${reason}", got ${JSON.stringify(matches.map((m) => m.reason))}`
    );
  }
  if (hit.confidence !== confidence) {
    throw new Error(`${label}: "${reason}" confidence ${hit.confidence}, expected ${confidence}`);
  }
}

// 1. The regression itself: empty index + a contact added mid-batch must still hit the
//    exact name+company tier at 0.9, not fall through to name-only at 0.6.
{
  const index = buildDuplicateIndex([]);
  addToDuplicateIndex(index, contact({ fullName: "Ada Lovelace", company: "Analytical Engines" }));

  const matches = findDuplicateCandidatesIndexed(index, {
    fullName: "Ada Lovelace",
    company: "Analytical Engines",
  });
  expectMatch(matches, "Same name + company", 0.9, "mid-batch name+company");
  if (matches[0].reason !== "Same name + company") {
    throw new Error(`mid-batch name+company: weaker tier ranked first (${matches[0].reason})`);
  }
  if (matches[0].confidence < DUPLICATE_MERGE_CONFIDENCE) {
    throw new Error("mid-batch name+company: should clear the auto-merge threshold");
  }
}

// 2. Same for the name+title tier at 0.85 (exactly at the auto-merge threshold).
{
  const index = buildDuplicateIndex([]);
  addToDuplicateIndex(index, contact({ fullName: "Grace Hopper", title: "Rear Admiral" }));

  const matches = findDuplicateCandidatesIndexed(index, {
    fullName: "Grace Hopper",
    title: "Rear Admiral",
  });
  expectMatch(matches, "Same name + title", 0.85, "mid-batch name+title");
  if (matches[0].confidence < DUPLICATE_MERGE_CONFIDENCE) {
    throw new Error("mid-batch name+title: should clear the auto-merge threshold");
  }
}

// 3. Contacts loaded up front (the buildDuplicateIndex path) keep working.
{
  const index = buildDuplicateIndex([
    contact({ fullName: "Alan Turing", company: "NPL", title: "Reader" }),
  ]);
  expectMatch(
    findDuplicateCandidatesIndexed(index, { fullName: "Alan Turing", company: "NPL" }),
    "Same name + company",
    0.9,
    "prebuilt name+company"
  );
  expectMatch(
    findDuplicateCandidatesIndexed(index, { fullName: "Alan Turing", title: "Reader" }),
    "Same name + title",
    0.85,
    "prebuilt name+title"
  );
}

// 4. Both entry points key the same way: a contact added mid-batch and the same contact
//    present at build time must produce identical results.
{
  const seed = contact({ fullName: "Katherine Johnson", company: "NASA", title: "Mathematician" });
  const incoming = { fullName: "katherine johnson", company: "nasa", title: "mathematician" };

  const prebuilt = findDuplicateCandidatesIndexed(buildDuplicateIndex([seed]), incoming);
  const added = buildDuplicateIndex([]);
  addToDuplicateIndex(added, seed);
  const midBatch = findDuplicateCandidatesIndexed(added, incoming);

  const shape = (ms: { reason: string; confidence: number }[]) =>
    JSON.stringify(ms.map((m) => [m.reason, m.confidence]));
  if (shape(prebuilt) !== shape(midBatch)) {
    throw new Error(`build vs add divergence: ${shape(prebuilt)} !== ${shape(midBatch)}`);
  }
}

// 5. The composite separator must not let field boundaries blur: "Ada Lovelace" @ "Corp"
//    is a different person from "Ada" @ "Lovelace Corp". A plain-space separator would
//    collide these into a false 0.9 auto-merge.
{
  const seed = contact({ fullName: "Ada Lovelace", company: "Corp" });
  const incoming = { fullName: "Ada", company: "Lovelace Corp" };

  const indexed = findDuplicateCandidatesIndexed(buildDuplicateIndex([seed]), incoming);
  if (indexed.some((m) => m.reason === "Same name + company")) {
    throw new Error("separator collision: distinct contacts matched on name + company");
  }
  // And the indexed path must agree with the linear reference implementation.
  const linear = findDuplicateCandidates([seed], incoming);
  if (linear.some((m) => m.reason === "Same name + company")) {
    throw new Error("separator collision: linear path disagrees (test fixture is wrong)");
  }
}

// 6. Cross-check the indexed and linear implementations across a small matrix, since the
//    indexed one is documented as having the same tiers and confidences.
{
  const existing = [
    contact({ fullName: "Ada Lovelace", company: "Analytical Engines", title: "Analyst" }),
    contact({ fullName: "Ada Lovelace", company: "Other Co", title: "Analyst" }),
    contact({ fullName: "Grace Hopper", company: "Navy", title: "Rear Admiral" }),
    contact({ fullName: "Alan Turing", email: "alan@npl.uk" }),
  ];
  const probes = [
    { fullName: "Ada Lovelace", company: "Analytical Engines" },
    { fullName: "Ada Lovelace", title: "Analyst" },
    { fullName: "Grace Hopper", company: "Navy", title: "Rear Admiral" },
    { fullName: "Alan Turing", email: "alan@npl.uk" },
    { fullName: "Ada Lovelace" },
    { fullName: "Nobody Here", company: "Analytical Engines" },
  ];

  const index = buildDuplicateIndex([]);
  for (const c of existing) addToDuplicateIndex(index, c);

  for (const probe of probes) {
    // Typed by what this actually reads, not by the row shape: the linear path is generic
    // over the caller's element type (full `Contact` fixtures here) while the indexed path
    // returns `DuplicateSubject`, and this only ever compares confidences.
    const best = (ms: { confidence: number }[]) =>
      ms.reduce((acc, m) => Math.max(acc, m.confidence), 0);
    const linear = findDuplicateCandidates(existing, probe);
    const indexed = findDuplicateCandidatesIndexed(index, probe);
    if (best(linear) !== best(indexed)) {
      throw new Error(
        `tier mismatch for ${JSON.stringify(probe)}: linear ${best(linear)} vs indexed ${best(indexed)}`
      );
    }
  }
}

console.log("duplicate index smoke tests passed");
process.exit(0);
