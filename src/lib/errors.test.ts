import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserFacingError, asActionResult, friendlyError, isUserFacingError } from "@/lib/errors";

describe("asActionResult", () => {
  it("wraps a returned value", async () => {
    assert.deepEqual(await asActionResult(async () => 42), { ok: true, value: 42 });
  });

  it("turns a UserFacingError into data, keeping the message", async () => {
    const result = await asActionResult(async () => {
      throw new UserFacingError("Give it a title first");
    });
    assert.deepEqual(result, { ok: false, error: "Give it a title first" });
  });

  it("turns a PaywallError (matched by name) into data", async () => {
    const paywall = Object.assign(new Error("Upgrade to add more"), { name: "PaywallError" });
    const result = await asActionResult(async () => {
      throw paywall;
    });
    assert.deepEqual(result, { ok: false, error: "Upgrade to add more" });
  });

  it("rethrows anything else untouched", async () => {
    const boom = new Error("db exploded");
    await assert.rejects(
      asActionResult(async () => {
        throw boom;
      }),
      (err) => err === boom
    );
  });
});

describe("isUserFacingError", () => {
  it("matches by name so a second module instance still counts", () => {
    const foreign = Object.assign(new Error("x"), { name: "UserFacingError" });
    assert.equal(isUserFacingError(foreign), true);
    assert.equal(isUserFacingError(new Error("x")), false);
    assert.equal(isUserFacingError("x"), false);
  });
});

describe("friendlyError", () => {
  it("shows a UserFacingError verbatim", () => {
    assert.equal(friendlyError(new UserFacingError("Connect Gmail first"), "fallback"), "Connect Gmail first");
  });

  it("never leaks a raw error message", () => {
    const text = friendlyError(new Error("ECONNRESET at 10.0.0.1:5432"), "Something went wrong");
    assert.equal(text.includes("10.0.0.1"), false);
  });
});
