import "../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalLinkedInProfileUrl,
  extractLinkedInSlug,
  isLinkedInProfileUrl,
} from "@/lib/identity/linkedin";
import { isLinkedInProfileUrl as viaContactInput } from "@/lib/contact-input";
import { linkedinSlug } from "@/lib/duplicates";
import { canonicalLinkedInUrl } from "@/lib/linkedin-paste";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import { linkedinUrlFrom } from "@/lib/events/platforms/next-data";
import { normalizeLinkedinUrl } from "@/lib/recruiters";

const ACCEPT = [
  "https://www.linkedin.com/in/jane-doe",
  "https://www.linkedin.com/in/Jane-Doe/",
  "  linkedin.com/in/jane-doe  ",
  "LINKEDIN.COM/IN/Jane",
  "https://uk.linkedin.com/in/jane-doe", // regional subdomain
  "www.linkedin.com/in/jane", // no scheme
  "https://www.linkedin.com/in/jane/?trk=x#frag", // trailing slash + query
  "https://www.linkedin.com/in/jane?utm=1",
  "https://www.linkedin.com/company/acme", // /company/
  "https://www.linkedin.com/",
  "http://linkedin.com/in/jane",
];
const REJECT = [
  "https://example.com/in/jane",
  "https://evil.com/linkedin.com/in/jane",
  "notlinkedin.com/in/jane",
  "https://linkedin.com.evil.com/in/jane",
  "ftp://linkedin.com/in/x",
  "jane-doe",
  "/in/jane",
  "",
  "   ",
];

describe("identity/linkedin isLinkedInProfileUrl (the lib rule, one copy)", () => {
  for (const u of ACCEPT) it(`accepts ${JSON.stringify(u)}`, () => assert.equal(isLinkedInProfileUrl(u), true));
  for (const u of REJECT) it(`rejects ${JSON.stringify(u)}`, () => assert.equal(isLinkedInProfileUrl(u), false));
  it("contact-input re-exports the same function", () => assert.equal(viaContactInput, isLinkedInProfileUrl));
});

describe("identity/linkedin extractLinkedInSlug / canonical builder", () => {
  it("extracts the raw slug, case and whitespace untouched", () => {
    assert.equal(extractLinkedInSlug("https://www.linkedin.com/in/Jane-Doe/"), "Jane-Doe");
    assert.equal(extractLinkedInSlug("  linkedin.com/in/jane-doe  "), "jane-doe  ");
    assert.equal(extractLinkedInSlug("https://uk.linkedin.com/in/jane?trk=1"), "jane");
    assert.equal(extractLinkedInSlug("www.linkedin.com/in/jane/?x#y"), "jane");
  });
  it("null for no /in/ path, non-linkedin, null, undefined, blank", () => {
    for (const v of ["https://www.linkedin.com/company/acme", "https://example.com/x", "jane", "", null, undefined]) {
      assert.equal(extractLinkedInSlug(v), null, String(v));
    }
  });
  it("canonical URL uses the slug verbatim", () => {
    assert.equal(canonicalLinkedInProfileUrl("jane"), "https://www.linkedin.com/in/jane");
    assert.equal(canonicalLinkedInProfileUrl("Jane-Doe"), "https://www.linkedin.com/in/Jane-Doe");
  });
});

describe("delegating helpers keep their own output forms", () => {
  const u = "https://uk.linkedin.com/in/Jane-Doe/?trk=1";
  it("one profile URL, four documented spellings", () => {
    assert.equal(linkedinSlug(u), "jane-doe");
    assert.equal(normalizeLinkedinUrl(u), "https://www.linkedin.com/in/jane-doe");
    assert.equal(buildLinkedInUrl(u), u);
    assert.equal(canonicalLinkedInUrl("Jane-Doe"), "https://www.linkedin.com/in/Jane-Doe");
  });
  it("linkedinUrlFrom (event platforms) builds through the shared builder", () => {
    assert.equal(linkedinUrlFrom("/in/jane-doe/"), "https://www.linkedin.com/in/jane-doe");
    assert.equal(linkedinUrlFrom("jane-doe"), "https://www.linkedin.com/in/jane-doe");
    assert.equal(linkedinUrlFrom("https://www.linkedin.com/in/jane"), "https://www.linkedin.com/in/jane");
    assert.equal(linkedinUrlFrom("https://example.com/x"), null);
    assert.equal(linkedinUrlFrom(null), null);
  });
  it("null / undefined / blank", () => {
    assert.equal(linkedinSlug(null), "");
    assert.equal(linkedinSlug(undefined), "");
    assert.equal(normalizeLinkedinUrl("  "), null);
  });
});
