import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_ORGANIZATION_RULE, PROFILE_FETCH_RULE, classifyOAuthFailure } from "@/lib/oauth-failure";

// Rows were first run against the three pre-consolidation copies in the Gmail, Outlook
// and Eventbrite callback routes: [input, Gmail/Outlook kind, Eventbrite kind].
const TABLE: Array<[unknown, string, string]> = [
  [new Error("Missing authorization code"), "missing_code", "missing_code"],
  [new Error("Signed-in user does not match OAuth state"), "state_mismatch", "state_mismatch"],
  [new Error("Invalid OAuth state"), "state_mismatch", "state_mismatch"],
  [new Error("Token exchange failed: boom"), "token_exchange_failed", "token_exchange_failed"],
  [new Error("Could not fetch Google profile"), "profile_fetch_failed", "other"],
  [new Error("Google account has no email"), "profile_fetch_failed", "other"],
  [new Error("No Eventbrite organization found"), "other", "no_organization"],
  [new Error("something else"), "other", "other"],
  ["Token exchange string", "token_exchange_failed", "token_exchange_failed"],
  [null, "other", "other"],
  [new Error("authorization code profile"), "missing_code", "missing_code"],
];

describe("classifyOAuthFailure", () => {
  for (const [input, mail, eb] of TABLE) {
    it(`classifies ${String(input)}`, () => {
      assert.equal(classifyOAuthFailure(input, PROFILE_FETCH_RULE), mail);
      assert.equal(classifyOAuthFailure(input, NO_ORGANIZATION_RULE), eb);
    });
  }
});
