import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dismissBackgroundJob,
  finishBackgroundJob,
  getBackgroundJob,
  hideBackgroundJobFromWidget,
  startBackgroundJob,
  updateBackgroundJob,
  useActiveBackgroundJobCount,
  useBackgroundJobs,
  type BackgroundJob,
} from "@/lib/background-jobs";
import { captureStore } from "@/lib/test-support/external-store-harness";

const store = captureStore<BackgroundJob[]>(useBackgroundJobs);

describe("background-jobs store", () => {
  it("starts empty, with a stable empty server snapshot", () => {
    const initial = store.getSnapshot();
    assert.deepEqual(initial, []);
    assert.equal(store.getSnapshot(), initial);
    assert.deepEqual(store.getServerSnapshot(), []);
    assert.equal(store.getServerSnapshot(), store.getServerSnapshot());
  });

  it("returns the same reference between emits and a new one after each mutation", () => {
    let fired = 0;
    const off = store.subscribe(() => fired++);
    const before = store.getSnapshot();
    startBackgroundJob({ id: "a", kind: "k", label: "A", startedAt: 1 });
    const afterStart = store.getSnapshot();
    assert.notEqual(afterStart, before);
    assert.equal(store.getSnapshot(), afterStart);
    assert.equal(fired, 1);
    assert.equal(afterStart[0].status, "running");
    assert.equal(afterStart[0].done, 0);

    startBackgroundJob({ id: "b", kind: "k", label: "B", startedAt: 5, total: 10 });
    assert.equal(fired, 2);
    assert.deepEqual(store.getSnapshot().map((j) => j.id), ["b", "a"], "newest first");

    const snap = store.getSnapshot();
    updateBackgroundJob("a", { done: 3 });
    assert.equal(fired, 3);
    assert.notEqual(store.getSnapshot(), snap);
    assert.equal(getBackgroundJob("a")?.done, 3);

    // No-ops do not emit and keep the reference.
    const stable = store.getSnapshot();
    updateBackgroundJob("missing", { done: 1 });
    dismissBackgroundJob("missing");
    finishBackgroundJob("missing", { status: "completed" });
    assert.equal(fired, 3);
    assert.equal(store.getSnapshot(), stable);

    hideBackgroundJobFromWidget("a");
    assert.equal(fired, 4);
    assert.equal(getBackgroundJob("a")?.hiddenFromWidget, true);

    dismissBackgroundJob("a");
    dismissBackgroundJob("b");
    assert.equal(fired, 6);
    assert.deepEqual(store.getSnapshot(), []);
    off();
  });

  it("finish moves a job to a terminal state and the active count follows", () => {
    const count = captureStore<BackgroundJob[]>(useActiveBackgroundJobCount);
    assert.equal(count.getSnapshot(), store.getSnapshot());
    startBackgroundJob({ id: "f", kind: "k", label: "F", startedAt: 1 });
    assert.equal(store.getSnapshot().filter((j) => j.status === "running").length, 1);
    finishBackgroundJob("f", { status: "completed", resultMessage: "ok" });
    const job = getBackgroundJob("f");
    assert.equal(job?.status, "completed");
    assert.equal(job?.cancelling, false);
    assert.equal(store.getSnapshot().filter((j) => j.status === "running").length, 0);
    dismissBackgroundJob("f"); // also clears the auto-remove timer so the process can exit
    assert.equal(getBackgroundJob("f"), null);
  });

  it("unsubscribe stops notifications; each subscriber fires once per emit", () => {
    let a = 0;
    let b = 0;
    const offA = store.subscribe(() => a++);
    const offB = store.subscribe(() => b++);
    startBackgroundJob({ id: "u", kind: "k", label: "U", startedAt: 1 });
    assert.deepEqual([a, b], [1, 1]);
    offA();
    updateBackgroundJob("u", { done: 1 });
    assert.deepEqual([a, b], [1, 2]);
    offB();
    updateBackgroundJob("u", { done: 2 });
    assert.deepEqual([a, b], [1, 2]);
    dismissBackgroundJob("u");
  });
});
