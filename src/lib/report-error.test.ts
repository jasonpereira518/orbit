import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { OFFLINE_MESSAGE, UserFacingError } from "@/lib/errors";
import { reportAndContinue, reportError, reportUnlessQuiet, reportedFailure } from "@/lib/report-error";

// Sentry stays off: nothing here sets SENTRY_DSN.
delete process.env.SENTRY_DSN;

let warn: ReturnType<typeof mock.method>;
let error: ReturnType<typeof mock.method>;

beforeEach(() => {
  warn = mock.method(console, "warn", () => {});
  error = mock.method(console, "error", () => {});
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

const firstArg = (spy: ReturnType<typeof mock.method>, n = 0) => String(spy.mock.calls[n]?.arguments[0]);

describe("reportError", () => {
  it("logs one greppable line and returns the 8-hex reference", () => {
    const ref = reportError(new Error("boom"), { where: "test.line" });
    assert.match(ref, /^[0-9a-f]{8}$/);
    assert.equal(error.mock.callCount(), 1);
    assert.equal(firstArg(error), `[orbit:test.line] ref=${ref}`);
  });

  it("appends the user id when given", () => {
    const ref = reportError(new Error("boom"), { where: "test.user", userId: "user_1" });
    assert.equal(firstArg(error), `[orbit:test.user] ref=${ref} user=user_1`);
  });

  it("uses console.warn for warnings", () => {
    reportError(new Error("x"), { where: "test.warnlevel", level: "warning" });
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(error.mock.callCount(), 0);
  });

  it("throttles warnings to one per minute per where, but not errors", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const ctx = { where: "test.throttle", level: "warning" } as const;
    reportError(new Error("1"), ctx);
    reportError(new Error("2"), ctx);
    assert.equal(warn.mock.callCount(), 1);
    reportError(new Error("other"), { ...ctx, where: "test.throttle.other" });
    assert.equal(warn.mock.callCount(), 2);
    mock.timers.tick(59_000);
    reportError(new Error("3"), ctx);
    assert.equal(warn.mock.callCount(), 2);
    mock.timers.tick(2_000);
    reportError(new Error("4"), ctx);
    assert.equal(warn.mock.callCount(), 3);
    reportError(new Error("e1"), { where: "test.throttle" });
    reportError(new Error("e2"), { where: "test.throttle" });
    assert.equal(error.mock.callCount(), 2);
  });

  it("scrubs secret-looking keys from extra and truncates long strings", () => {
    reportError(new Error("x"), {
      where: "test.scrub",
      extra: { apiKey: "sk-1", accessToken: "t", password: "p", authorization: "a", cookie: "c", provider: "stripe", big: "z".repeat(600) },
    });
    const extra = error.mock.calls[0].arguments[2] as Record<string, unknown>;
    assert.deepEqual(Object.keys(extra).sort(), ["big", "provider"]);
    assert.equal(extra.provider, "stripe");
    assert.equal((extra.big as string).length, 501);
  });

  it("never throws, even if console throws", () => {
    mock.method(console, "error", () => {
      throw new Error("console is broken");
    });
    let ref = "";
    assert.doesNotThrow(() => {
      ref = reportError(new Error("x"), { where: "test.console-throws" });
    });
    assert.match(ref, /^[0-9a-f]{8}$/);
  });
});

describe("reportAndContinue", () => {
  it("reports at warning level and resolves to the fallback", async () => {
    const value = await Promise.reject(new Error("db down")).catch(reportAndContinue({ where: "test.continue" }, 0));
    assert.equal(value, 0);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(firstArg(warn), /^\[orbit:test\.continue\] ref=[0-9a-f]{8}$/);
  });
});

describe("reportedFailure", () => {
  it("keeps a UserFacingError's text and does not report it", () => {
    const out = reportedFailure(new UserFacingError("Give it a title first"), "Something went wrong", { where: "test.uf" });
    assert.deepEqual(out, { error: "Give it a title first", ref: null });
    assert.equal(error.mock.callCount() + warn.mock.callCount(), 0);
  });

  it("does not report a quiet failure (offline)", () => {
    const out = reportedFailure(new Error(OFFLINE_MESSAGE), "Something went wrong", { where: "test.quiet" });
    assert.equal(out.ref, null);
    assert.equal(error.mock.callCount() + warn.mock.callCount(), 0);
  });

  it("reports an unknown fault and puts the reference in the message", () => {
    const out = reportedFailure(new Error("kaboom"), "Could not save", { where: "test.fault" });
    assert.match(out.ref ?? "", /^[0-9a-f]{8}$/);
    assert.ok(out.error.includes(out.ref as string));
    assert.equal(error.mock.callCount(), 1);
    assert.match(firstArg(error), /^\[orbit:test\.fault\] ref=[0-9a-f]{8}$/);
  });
});

describe("reportUnlessQuiet", () => {
  it("stays quiet for user-facing and quiet failures", () => {
    assert.equal(reportUnlessQuiet(new UserFacingError("nope"), { where: "test.uq1" }), null);
    assert.equal(reportUnlessQuiet(new Error(OFFLINE_MESSAGE), { where: "test.uq2" }), null);
    assert.equal(error.mock.callCount() + warn.mock.callCount(), 0);
  });

  it("reports a fault as a warning and returns the ref", () => {
    const ref = reportUnlessQuiet(new Error("kaboom"), { where: "test.uq3" });
    assert.match(ref ?? "", /^[0-9a-f]{8}$/);
    assert.equal(warn.mock.callCount(), 1);
  });
});
