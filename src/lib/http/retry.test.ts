import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, fetchWithRetry, retryAfterMs } from "./retry";

// The four byte-identical copies (apollo, eventbrite, luma, guarded-fetch).
const legacyJittered = (attempt: number) => 300 * 2 ** attempt + Math.floor(Math.random() * 250);
// The Graph / Google inline formula.
const legacyGraph = (attempt: number) =>
  Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;

function withRandom<T>(value: number, fn: () => T): T {
  const orig = Math.random;
  Math.random = () => value;
  let async = false;
  try {
    const out = fn();
    if (out instanceof Promise) {
      async = true;
      return out.finally(() => {
        Math.random = orig;
      }) as T;
    }
    return out;
  } finally {
    if (!async) Math.random = orig;
  }
}

describe("backoffMs", () => {
  it("defaults reproduce the Apollo/Eventbrite/Luma/guarded-fetch ladder", () => {
    for (const r of [0, 0.001, 0.5, 0.999999]) {
      for (let attempt = 0; attempt < 6; attempt++) {
        withRandom(r, () => assert.equal(backoffMs(attempt), legacyJittered(attempt)));
      }
    }
    withRandom(0, () => assert.deepEqual([0, 1, 2].map((a) => backoffMs(a)), [300, 600, 1200]));
  });

  it("graph/google options reproduce their inline formula", () => {
    const opts = { baseMs: 500, maxMs: 30_000, integerJitter: false };
    for (const r of [0, 0.3, 0.999]) {
      for (let attempt = 0; attempt < 9; attempt++) {
        withRandom(r, () => assert.equal(backoffMs(attempt, opts), legacyGraph(attempt)));
      }
    }
    withRandom(0, () => assert.equal(backoffMs(10, opts), 30_000));
  });

  it("uses an injected random exactly once", () => {
    let calls = 0;
    backoffMs(1, { random: () => (calls++, 0.5) });
    assert.equal(calls, 1);
  });
});

describe("retryAfterMs", () => {
  const res = (v?: string) => new Response(null, { headers: v === undefined ? {} : { "retry-after": v } });
  it("accepts positive numbers, rejects the rest", () => {
    assert.equal(retryAfterMs(res("2")), 2000);
    assert.equal(retryAfterMs(res("0.5")), 500);
    for (const v of [undefined, "0", "-3", "abc", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      assert.equal(retryAfterMs(res(v)), null);
    }
  });
});

describe("fetchWithRetry", () => {
  const retry429 = (r: Response) => r.status === 429;
  function harness(statuses: Array<number | [number, string]>) {
    const calls: Array<{ signal?: AbortSignal | null }> = [];
    const sleeps: number[] = [];
    let i = 0;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls.push({ signal: init?.signal });
      const s = statuses[Math.min(i++, statuses.length - 1)];
      const [status, ra] = Array.isArray(s) ? s : [s, undefined];
      return new Response(null, { status, headers: ra ? { "retry-after": ra } : {} });
    }) as typeof fetch;
    return { calls, sleeps, init: { timeoutMs: 1000, fetchImpl, sleep: async (ms: number) => void sleeps.push(ms) } };
  }

  it("returns ok at once with no sleep", async () => {
    const h = harness([200]);
    const res = await fetchWithRetry("http://x", h.init, { maxRetries: 5, maxDelayMs: 30_000, isRetryable: retry429 });
    assert.equal(res.status, 200);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  it("does not retry a non-retryable status", async () => {
    const h = harness([500]);
    const res = await fetchWithRetry("http://x", h.init, { maxRetries: 5, maxDelayMs: 30_000, isRetryable: retry429 });
    assert.equal(res.status, 500);
    assert.equal(h.calls.length, 1);
  });

  it("retries with the graph ladder, fresh signals, and returns the last response after maxRetries", async () => {
    const h = harness([429]);
    const res = await withRandom(0.5, () =>
      fetchWithRetry("http://x", h.init, { maxRetries: 3, maxDelayMs: 30_000, isRetryable: retry429 })
    );
    assert.equal(res.status, 429);
    assert.equal(h.calls.length, 4);
    assert.deepEqual(h.sleeps, [0, 1, 2].map((a) => withRandom(0.5, () => legacyGraph(a))));
    assert.equal(new Set(h.calls.map((c) => c.signal)).size, 4);
  });

  it("honours Retry-After, capped at maxDelayMs; ignores invalid values", async () => {
    const h = harness([[429, "2"], [429, "100"], [429, "0"], 200]);
    await withRandom(0, () =>
      fetchWithRetry("http://x", h.init, { maxRetries: 5, maxDelayMs: 30_000, isRetryable: retry429 })
    );
    assert.deepEqual(h.sleeps, [2000, 30_000, legacyGraphAt(0.0, 2)]);
  });

  it("awaits an async isRetryable (google body sniffing)", async () => {
    const h = harness([403, 200]);
    const res = await fetchWithRetry("http://x", h.init, {
      maxRetries: 5,
      maxDelayMs: 30_000,
      isRetryable: async (r) => r.status === 403,
    });
    assert.equal(res.status, 200);
    assert.equal(h.sleeps.length, 1);
  });
});

function legacyGraphAt(r: number, attempt: number) {
  return withRandom(r, () => legacyGraph(attempt));
}
