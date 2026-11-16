import "../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeEmail } from "@/lib/identity/email";
import { normalizeEmail as fromRecruiters } from "@/lib/recruiters";
import { normalizeEmail as fromActivity } from "@/lib/email-activity";

const TABLE: Array<[string | null | undefined, string | null]> = [
  ["jane@example.com", "jane@example.com"],
  ["Jane@Example.com", "jane@example.com"],
  ["JANE@EXAMPLE.COM", "jane@example.com"],
  ["  jane@example.com  ", "jane@example.com"],
  ["a@b", "a@b"],
  ["Jane Doe <jane@x.com>", "jane doe <jane@x.com>"],
  ["jane", null], // no @
  ["", null],
  ["   ", null],
  [null, null],
  [undefined, null],
];

describe("identity/email normalizeEmail", () => {
  for (const [input, expected] of TABLE) {
    it(JSON.stringify(input), () => {
      assert.equal(normalizeEmail(input), expected);
      // the recruiters / email-activity names are the same function
      assert.equal(fromRecruiters(input), expected);
      assert.equal(fromActivity(input), expected);
    });
  }
  it("never throws on null/undefined", () => {
    assert.doesNotThrow(() => normalizeEmail(null));
    assert.doesNotThrow(() => normalizeEmail(undefined));
  });
});
