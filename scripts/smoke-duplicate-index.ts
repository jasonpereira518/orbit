/**
 * Guards the indexed duplicate-detection path in src/lib/duplicates.ts.
 *
 * Regressions covered:
 *  - The composite Map keys for byNameCompany/byNameTitle were built with a different
 *    separator by the writer (addToDuplicateIndex) than by the builder and reader
 *    (buildDuplicateIndex / findDuplicateCandidatesIndexed). Contacts created mid-batch
 *    therefore never matched the 0.9 "name + company" or 0.85 "name + title" tiers,
 *    silently under-merging within a single large import.
 *  - The fuzzy fallback bucketed on the first three letters of the whole name, so
 *    "Jon Smith" and "John Smith" could never be compared to each other.
 *  - There were two matchers with different semantics. There is now one; `matchAgainst`
 *    is a thin wrapper and must agree with the prebuilt-index path exactly.
 *
 * Also guards `identityKeysFor`, whose output is written verbatim into the unique
 * `contact_identities` index — a normalisation change here silently changes which
 * contacts can coexist.
 */
import {
  buildDuplicateIndex,
  addToDuplicateIndex,
  findDuplicateCandidatesIndexed,
  matchAgainst,
  identityKeysFor,
  isRoleEmail,
  normalizePhone,
  nameSimilarity,
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
  // And the convenience wrapper must agree with the prebuilt-index path.
  const wrapped = matchAgainst([seed], incoming);
  if (wrapped.some((m) => m.reason === "Same name + company")) {
    throw new Error("separator collision: matchAgainst disagrees (test fixture is wrong)");
  }
}

// 6. `matchAgainst` builds a throwaway index; it must produce byte-identical results to a
//    hoisted index across a matrix of probes. This is what used to be a linear-vs-indexed
//    differential — the two implementations have been collapsed into one, so this now
//    guards the wrapper rather than a second copy of the tiers.
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
    const shape = (ms: { reason: string; confidence: number; strong: boolean }[]) =>
      JSON.stringify(ms.map((m) => [m.reason, m.confidence, m.strong]));
    const wrapped = matchAgainst(existing, probe);
    const indexed = findDuplicateCandidatesIndexed(index, probe);
    if (shape(wrapped) !== shape(indexed)) {
      throw new Error(
        `matchAgainst mismatch for ${JSON.stringify(probe)}: ${shape(wrapped)} vs ${shape(indexed)}`
      );
    }
  }
}

// 7. The fuzzy bucket fix. "Jon Smith" vs "John Smith" normalise to `jon`/`joh`, so a
//    first-3-of-the-whole-name bucket put them in different buckets and the pair was
//    invisible to the matcher no matter how similar the names were. Bucketing on the last
//    token too ("smi" for both) is what makes this reachable.
{
  const seed = contact({ fullName: "John Smith", company: "Acme" });
  const matches = matchAgainst([seed], { fullName: "Jon Smith", company: "Acme" });
  expectMatch(matches, "Similar name + company", 0.87, "fuzzy across first-token buckets");
  if (nameSimilarity("Jon Smith", "John Smith") < 0.88) {
    throw new Error("fixture broken: these names are not similar enough to reach the tier");
  }
}

// 8. ...and the reverse: a typo in the *last* name must still share the first-token bucket.
{
  const seed = contact({ fullName: "Katherine Johnson", title: "Mathematician" });
  const matches = matchAgainst([seed], { fullName: "Katherine Johnsen", title: "Mathematician" });
  expectMatch(matches, "Similar name + title", 0.85, "fuzzy across last-token buckets");
}

// 9. A contact sitting in two buckets (both name tokens starting the same) must still be
//    reported once, not twice.
{
  const seed = contact({ fullName: "Sam Sample", company: "Acme" });
  const matches = matchAgainst([seed], { fullName: "Sam Sample", company: "Acme" });
  if (matches.length !== 1) {
    throw new Error(`double-bucket contact reported ${matches.length} times, expected 1`);
  }
}

// 10. Only identifier tiers are `strong`. This is the flag write paths key auto-merge off,
//     so a name tier drifting into it would restore exactly the silent wrong-merges this
//     work removed.
{
  const seed = contact({
    fullName: "Ada Lovelace",
    company: "Analytical Engines",
    email: "ada@example.com",
  });
  const strong = matchAgainst([seed], { fullName: "Ada Lovelace", email: "ada@example.com" });
  if (!strong[0].strong) throw new Error("email match should be strong");

  const weak = matchAgainst([seed], { fullName: "Ada Lovelace", company: "Analytical Engines" });
  if (weak[0].strong) throw new Error("name + company match must not be strong");
  if (weak[0].confidence < DUPLICATE_MERGE_CONFIDENCE) {
    throw new Error("fixture broken: name + company should still clear the display threshold");
  }
}

// 11. identityKeysFor: normalisation, ordering, and what is deliberately excluded.
{
  const keys = identityKeysFor({
    email: "  Ada@Example.COM ",
    linkedinUrl: "https://www.linkedin.com/in/AdaLovelace/?trk=x",
    xHandle: "@AdaL",
    phone: "(415) 555-0100",
  });
  const shape = JSON.stringify(keys.map((k) => [k.kind, k.value]));
  const expected = JSON.stringify([
    ["email", "ada@example.com"],
    ["linkedin_slug", "adalovelace"],
    ["phone_e164", "+14155550100"],
    ["x_handle", "adal"],
  ]);
  if (shape !== expected) throw new Error(`identityKeysFor shape ${shape}, expected ${expected}`);

  // Sorted by (kind, value). The insert that consumes these takes row locks in this order;
  // an unsorted multi-VALUES upsert deadlocks against a concurrent one touching the same
  // two identities in the opposite order.
  const kinds = keys.map((k) => k.kind);
  if (JSON.stringify(kinds) !== JSON.stringify([...kinds].sort())) {
    throw new Error("identityKeysFor must return keys sorted by kind");
  }
}

// 12. A shared mailbox is not an identity. Without this, three people at one company who
//     all list info@acme.com would be forced into a single contact by the unique index.
{
  if (!isRoleEmail("info@acme.com")) throw new Error("info@ should be a role address");
  if (!isRoleEmail("No-Reply+tag@acme.com")) throw new Error("plus-tagged role address missed");
  if (isRoleEmail("ada@acme.com")) throw new Error("a personal address is not a role address");

  const keys = identityKeysFor({ email: "info@acme.com" });
  if (keys.length) throw new Error("role address must not produce an identity key");
}

// 13. Phone normalisation only emits a key when the number is unambiguous. A partial or
//     unprefixed international number must produce nothing rather than a wrong key.
{
  const cases: [string, string][] = [
    ["+44 20 7946 0958", "+442079460958"],
    ["1 (415) 555-0100", "+14155550100"],
    ["415-555-0100", "+14155550100"],
    ["555-0100", ""],
    ["020 7946 0958", ""],
    ["", ""],
  ];
  for (const [input, want] of cases) {
    const got = normalizePhone(input);
    if (got !== want) throw new Error(`normalizePhone(${input}) = "${got}", expected "${want}"`);
  }
}

// 14. Nothing identifying at all means no identity keys — such a record can only ever
//     produce a review suggestion, never an automatic merge.
{
  if (identityKeysFor({}).length) throw new Error("empty input produced identity keys");
  if (identityKeysFor({ email: "not-an-address" }).length) {
    throw new Error("a string without @ is not an email identity");
  }
}

console.log("duplicate index smoke tests passed");
process.exit(0);
