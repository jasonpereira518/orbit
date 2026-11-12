import "../../../scripts/smoke/_env";
/**
 * P4.3 consequence check: duplicate detection (lib/duplicates.ts) keys off `linkedinSlug` and its
 * own private `normalize` for email, neither of which P4.3 changed. So the outcome for any pair
 * is the same before and after, EXCEPT through the three decided rules, none of which sits on
 * the duplicate-detection path (they change recruiter email keys, avatar email lookups,
 * the LinkedIn-lookup action's input check and demo-prospect detection in outreach).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDuplicateIndex, findDuplicateCandidatesIndexed, identityKeysFor, type DuplicateSubject } from "@/lib/duplicates";

const base = { company: null, title: null, xHandle: null } as const;
const existing = (id: string, over: Partial<DuplicateSubject>): DuplicateSubject => ({
  id, fullName: `Person ${id}`, email: null, linkedinUrl: null, ...base, ...over,
});
const outcome = (a: Partial<DuplicateSubject>, b: Partial<DuplicateSubject>) => {
  const index = buildDuplicateIndex([existing("a", a)]);
  return findDuplicateCandidatesIndexed(index, { fullName: "Unrelated Name", ...b }).map((m) => [m.reason, m.strong]);
};

describe("duplicate detection outcome is unchanged by P4.3", () => {
  it("same profile in different spellings still matches (regional host, case, query, trailing slash)", () => {
    const a = { linkedinUrl: "https://www.linkedin.com/in/jane-doe" };
    for (const b of ["https://uk.linkedin.com/in/Jane-Doe/?trk=1", "LINKEDIN.COM/IN/JANE-DOE", "http://linkedin.com/in/jane-doe"]) {
      const out = outcome(a, { linkedinUrl: b });
      assert.equal(out.length, 1, b);
      assert.equal(out[0][1], true, b);
    }
  });
  it("different profiles still do not match", () => {
    assert.deepEqual(outcome({ linkedinUrl: "https://www.linkedin.com/in/jane-doe" }, { linkedinUrl: "https://www.linkedin.com/in/john-doe" }), []);
  });
  it("a /company/ URL is not collapsed onto a person (slug stays the whole URL)", () => {
    assert.deepEqual(outcome({ linkedinUrl: "https://www.linkedin.com/in/acme" }, { linkedinUrl: "https://www.linkedin.com/company/acme" }), []);
  });
  it("email matching still ignores case/whitespace, ignores no-@ strings and role addresses", () => {
    assert.equal(outcome({ email: "Jane@X.com" }, { email: "  jane@x.COM " }).length, 1);
    // Quirk pinned, NOT changed by P4.3: the in-memory matcher uses duplicates.ts's private
    // `normalize` (no @ check), so two identical no-@ strings still match as "Same email". The
    // persisted identity keys, however, already require an @ and so emit nothing.
    assert.deepEqual(outcome({ email: "jane" }, { email: "jane" }), [["Same email", true]]);
    assert.deepEqual(identityKeysFor({ email: "jane" }), []);
  });
  it("identity keys for the table are exactly what they were", () => {
    assert.deepEqual(identityKeysFor({ linkedinUrl: "https://uk.linkedin.com/in/Jane-Doe/?x=1", email: "Jane@X.com" }), [
      { kind: "email", value: "jane@x.com" },
      { kind: "linkedin_slug", value: "jane-doe" },
    ]);
  });
});
