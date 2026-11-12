import "../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as mod from "@/lib/capture/job-store";
import type { CaptureJobView } from "@/lib/capture-jobs";
import { captureStore, installBrowser } from "@/lib/test-support/external-store-harness";

const env = installBrowser();
const g = globalThis as Record<string, unknown>;
const realFetch = g.fetch;
let fetchReply: unknown = { ok: true, unchanged: true };
let fetches = 0;
g.fetch = async () => {
  fetches++;
  return new Response(JSON.stringify(fetchReply), { status: 200 });
};
after(() => {
  env.restore();
  g.fetch = realFetch;
});
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

const job = (over: Record<string, unknown> = {}) =>
  ({ id: "j1", status: "extracting", updatedAt: "2026-01-01T00:00:00.000Z", ...over }) as unknown as CaptureJobView;

const store = captureStore<mod.CaptureJobSnapshot>(mod.useCaptureJob);

describe("capture job-store", () => {
  it("initial snapshot is one stable EMPTY object, equal to the SSR snapshot", () => {
    const s = store.getSnapshot();
    assert.deepEqual(s, { job: null, error: null });
    assert.equal(store.getSnapshot(), s);
    assert.equal(store.getServerSnapshot(), s);
    assert.equal(store.getServerSnapshot(), store.getServerSnapshot());
  });

  let fired = 0;
  let off: () => void = () => {};

  it("subscribing with no job starts no timer and attaches nothing", () => {
    off = store.subscribe(() => fired++);
    assert.equal(env.intervals.size, 0);
    assert.equal(env.document.count("visibilitychange"), 0);
    assert.equal(fired, 0);
  });

  it("seeding a polling-status job emits once, new stable snapshot, and starts exactly one poll", () => {
    const before = store.getSnapshot();
    mod.seedCaptureJob(job());
    assert.equal(fired, 1);
    const s = store.getSnapshot();
    assert.notEqual(s, before);
    assert.equal(s.job?.id, "j1");
    assert.equal(s.error, null);
    assert.equal(store.getSnapshot(), s);
    assert.equal(env.intervals.size, 1);
    assert.equal([...env.intervals.values()][0].ms, mod.CAPTURE_POLL_MS);
    // The poll's own handler plus the connectivity store's (started via onReconnect).
    assert.equal(env.document.count("visibilitychange"), 2);
    mod.seedCaptureJob(job({ updatedAt: "2026-01-01T00:00:01.000Z" }));
    assert.equal(fired, 2);
    assert.equal(env.intervals.size, 1, "still one interval");
  });

  it("a stale seed for the same job is ignored (no emit, same reference); force overrides", () => {
    const s = store.getSnapshot();
    mod.seedCaptureJob(job({ updatedAt: "2026-01-01T00:00:00.500Z" }));
    assert.equal(fired, 2);
    assert.equal(store.getSnapshot(), s);
    mod.seedCaptureJob(job({ updatedAt: "2025-12-31T00:00:00.000Z" }), { force: true });
    assert.equal(fired, 3);
    assert.notEqual(store.getSnapshot(), s);
    mod.seedCaptureJob(job({ updatedAt: "2026-01-01T00:00:01.000Z" }), { force: true });
    assert.equal(fired, 4);
  });

  it("refresh: unchanged keeps the snapshot; a newer job replaces it; a failure sets error then good poll clears it", async () => {
    const s = store.getSnapshot();
    fetchReply = { ok: true, unchanged: true };
    await mod.refreshCaptureJob();
    assert.equal(fetches, 1);
    assert.equal(fired, 4);
    assert.equal(store.getSnapshot(), s);

    fetchReply = { ok: false, error: "nope" };
    await mod.refreshCaptureJob();
    assert.equal(store.getSnapshot().error, "nope");
    assert.equal(fired, 5);
    assert.equal(store.getSnapshot().job?.id, "j1");

    fetchReply = { ok: true, unchanged: true };
    await mod.refreshCaptureJob();
    assert.equal(store.getSnapshot().error, null, "an unchanged poll clears a stale error");
    assert.equal(fired, 6);

    fetchReply = { ok: true, job: job({ status: "saved", updatedAt: "2026-01-01T00:00:09.000Z" }) };
    await mod.refreshCaptureJob();
    assert.equal(store.getSnapshot().job?.status, "saved");
    assert.equal(env.intervals.size, 0, "terminal status stops the poll");
    assert.equal(env.document.count("visibilitychange"), 0);
  });

  it("coalesces concurrent refreshes into one request", async () => {
    mod.seedCaptureJob(job({ id: "j2", status: "queued", updatedAt: "2026-02-01T00:00:00.000Z" }));
    fetchReply = { ok: true, unchanged: true };
    const before = fetches;
    const a = mod.refreshCaptureJob();
    const b = mod.refreshCaptureJob();
    assert.equal(a, b);
    await a;
    await tick();
    assert.equal(fetches, before + 1);
  });

  it("clearCaptureJob empties (fresh object), stops the poll and emits", () => {
    const before = fired;
    mod.clearCaptureJob();
    assert.equal(fired, before + 1);
    assert.deepEqual(store.getSnapshot(), { job: null, error: null });
    assert.equal(env.intervals.size, 0);
  });

  it("unsubscribe stops notifications; the poll follows the subscriber count", () => {
    mod.seedCaptureJob(job({ id: "j3", status: "saving", updatedAt: "2026-03-01T00:00:00.000Z" }));
    assert.equal(env.intervals.size, 1);
    off();
    assert.equal(env.intervals.size, 0, "last subscriber gone: no polling");
    const before = fired;
    mod.seedCaptureJob(job({ id: "j3", status: "saving", updatedAt: "2026-03-02T00:00:00.000Z" }));
    assert.equal(fired, before);
    assert.equal(env.intervals.size, 0);
    // A new subscriber to an in-progress job starts the poll on subscribe.
    let again = 0;
    const off2 = store.subscribe(() => again++);
    assert.equal(env.intervals.size, 1);
    mod.clearCaptureJob();
    assert.equal(again, 1);
    off2();
    assert.equal(env.intervals.size, 0);
  });
});
