import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { sleep, TimeoutError, withTimeout } from "./async";

describe("sleep", () => {
  it("resolves after the delay", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let done = false;
      const p = sleep(500).then(() => (done = true));
      mock.timers.tick(499);
      await Promise.resolve();
      assert.equal(done, false);
      mock.timers.tick(1);
      await p;
      assert.equal(done, true);
    } finally {
      mock.timers.reset();
    }
  });

  it("wakes early on abort and resolves at once when already aborted", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const c = new AbortController();
      const p = sleep(60_000, c.signal);
      c.abort();
      await p; // resolves without ticking
      await sleep(60_000, c.signal);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("withTimeout", () => {
  it("passes the value through and clears the timer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
      assert.equal(mock.timers.runAll(), undefined);
    } finally {
      mock.timers.reset();
    }
  });

  it("passes the original rejection through", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const boom = new Error("boom");
      await assert.rejects(withTimeout(Promise.reject(boom), 1000), (e) => e === boom);
    } finally {
      mock.timers.reset();
    }
  });

  it("rejects with TimeoutError(message) at exactly ms", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const never = new Promise<number>(() => {});
      const errs: unknown[] = [];
      const p = withTimeout(never, 12_000, "orbit:timed-out").catch((e) => errs.push(e));
      mock.timers.tick(11_999);
      await Promise.resolve();
      assert.equal(errs.length, 0);
      mock.timers.tick(1);
      await p;
      const err = errs[0];
      assert.ok(err instanceof TimeoutError);
      assert.ok(err instanceof Error);
      assert.equal(err.message, "orbit:timed-out");
    } finally {
      mock.timers.reset();
    }
  });

  it("defaults the message to 'timed out' (lib/health.ts)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const p = withTimeout(new Promise(() => {}), 5);
      mock.timers.tick(5);
      await assert.rejects(p, { message: "timed out" });
    } finally {
      mock.timers.reset();
    }
  });
});
