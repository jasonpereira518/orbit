/**
 * Guards `isSelf` in src/lib/self-identity.ts — the filter that stops capture creating a
 * contact for the account owner.
 *
 * Two failure modes matter here and they pull in opposite directions:
 *
 *   - Too loose, and a real contact who shares the user's name is silently dropped from
 *     the extraction. Nobody ever learns they existed, so nothing surfaces the mistake.
 *     The "same name, different email" case below is what keeps that from happening.
 *   - Too strict, and the original bug comes back: the user is seeded from a pasted invite
 *     and force-added as a participant by `parseMultiPersonTwoPass`.
 *
 * `getSelfIdentity` is not covered here — it is a plain read of four tables. What is worth
 * pinning is the decision function, which is pure.
 */
import {
  isSelf,
  SELF_NAME_SIMILARITY,
  EMPTY_SELF_IDENTITY,
  type SelfIdentity,
  type SelfProbe,
} from "../src/lib/self-identity";

function identity(over: Partial<SelfIdentity> = {}): SelfIdentity {
  return {
    emails: new Set(["jason@orbit.app"]),
    linkedinSlug: "jasonpereira",
    name: "Jason Pereira",
    ...over,
  };
}

let failures = 0;
function check(label: string, probe: SelfProbe, self: SelfIdentity, want: boolean) {
  const got = isSelf(probe, self);
  if (got !== want) {
    failures += 1;
    console.error(
      `FAIL ${label}: expected isSelf=${want}, got ${got} for ${JSON.stringify(probe)}`
    );
  }
}

const self = identity();

/* Hard identifiers -------------------------------------------------------------------- */

check("own Clerk email", { name: "J. Pereira", email: "jason@orbit.app" }, self, true);
check(
  "email match is case- and whitespace-insensitive",
  { email: "  JASON@Orbit.App " },
  self,
  true
);
check(
  "a connected mailbox address counts",
  { email: "jason.pereira@gmail.com" },
  identity({ emails: new Set(["jason@orbit.app", "jason.pereira@gmail.com"]) }),
  true
);
check(
  "own LinkedIn URL, no email",
  { name: "JP", linkedinUrl: "https://www.linkedin.com/in/jasonpereira/" },
  self,
  true
);
check(
  "somebody else's LinkedIn URL",
  { name: "Dana Cruz", linkedinUrl: "https://linkedin.com/in/danacruz" },
  self,
  false
);

/* The guard that makes name matching safe --------------------------------------------- */

check(
  "same name, different email is NOT self",
  { name: "Jason Pereira", email: "jason.pereira@someothercompany.com" },
  self,
  false
);
check(
  "an email we don't know short-circuits even an exact name",
  { name: "Jason Pereira", email: "jp@example.org", linkedinUrl: null },
  self,
  false
);

/* Name matching, only when there is no contradicting address --------------------------- */

check("same name, no email", { name: "Jason Pereira" }, self, true);
check("name with an accent and punctuation", { name: "Jasón  Pereira!" }, self, true);
check("a genuinely different person", { name: "Dana Cruz" }, self, false);
check("a different Pereira", { name: "Maria Pereira" }, self, false);

// A mononym owner gets no name-based filtering at all. `nameSimilarity` short-circuits to
// 1 on an exact match before its under-4-characters guard, so without the two-token rule
// in `isSelf` an owner recorded as "Jay" would swallow every Jay in every note.
check("mononym owner does not match on name", { name: "Jay" }, identity({ name: "Jay" }), false);
check(
  "...but a mononym owner is still caught by email",
  { name: "Jay", email: "jason@orbit.app" },
  identity({ name: "Jay" }),
  true
);
check(
  "a first name alone does not match a full owner name",
  { name: "Jason" },
  self,
  false
);

/* Degenerate identities ---------------------------------------------------------------- */

check("empty identity matches nobody", { name: "Jason Pereira" }, EMPTY_SELF_IDENTITY, false);
check(
  "empty identity matches nobody, even with an email",
  { email: "jason@orbit.app" },
  EMPTY_SELF_IDENTITY,
  false
);
check("no name and no email", {}, self, false);
check(
  "unpopulated Clerk mirror falls back to hard identifiers only",
  { name: "Jason Pereira" },
  identity({ name: "" }),
  false
);

/* The threshold is deliberately stricter than the merge threshold ---------------------- */

if (SELF_NAME_SIMILARITY <= 0.85) {
  failures += 1;
  console.error(
    `FAIL: SELF_NAME_SIMILARITY (${SELF_NAME_SIMILARITY}) must stay above DUPLICATE_MERGE_CONFIDENCE (0.85) — ` +
      "a false positive here drops a real person silently, unlike a merge suggestion, which is shown for confirmation."
  );
}

if (failures) {
  console.error(`\nself-identity smoke tests FAILED (${failures})`);
  process.exit(1);
}

console.log("self-identity smoke tests passed");
process.exit(0);
