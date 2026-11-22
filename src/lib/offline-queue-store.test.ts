import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  canQueueOffline,
  configureOfflineQueue,
  flushOfflineQueue,
  isQueuedOffline,
  queueOfflineAction,
  useIsQueuedOffline,
  useOfflineQueue,
  type OfflineRunners,
} from "@/lib/offline-queue-store";
import type { QueuedAction } from "@/lib/offline-queue";
import { captureStore, installBrowser } from "@/lib/test-support/external-store-harness";

type Env = ReturnType<typeof installBrowser>;
let env: Env;
beforeEach(() => {
  env = installBrowser();
});
afterEach(() => env.restore());

const runners: OfflineRunners = {} as OfflineRunners;

describe("offline-queue-store", () => {
  it("is empty and unconfigured before OfflineSync mounts; SSR snapshot is empty and stable", () => {
    const store = captureStore<readonly QueuedAction[]>(useOfflineQueue);
    assert.equal(canQueueOffline(), false);
    assert.equal(queueOfflineAction({ kind: "reminder.done", args: ["r1"], subject: "r1" }), false);
    const s = store.getSnapshot();
    assert.equal(s.length, 0);
    assert.equal(store.getSnapshot(), s);
    assert.equal(store.getServerSnapshot(), store.getServerSnapshot());
    assert.equal(store.getServerSnapshot().length, 0);
    assert.equal(store.getServerSnapshot(), s, "empty client and server snapshots share one constant");
  });

  it("configure emits once, attaches a storage listener, teardown emits and detaches", () => {
    const store = captureStore<readonly QueuedAction[]>(useOfflineQueue);
    let fired = 0;
    const off = store.subscribe(() => fired++);
    const empty = store.getSnapshot();
    const teardown = configureOfflineQueue("user-1", runners);
    assert.equal(fired, 1);
    assert.equal(canQueueOffline(), true);
    assert.equal(env.window.count("storage"), 1);
    assert.equal(store.getSnapshot(), empty, "an empty queue keeps the EMPTY reference");
    teardown();
    assert.equal(fired, 2);
    assert.equal(env.window.count("storage"), 0);
    assert.equal(canQueueOffline(), false);
    assert.equal(store.getSnapshot(), empty);
    off();
  });

  it("queueing changes the snapshot once per mutation, stable between, mirrors to storage", () => {
    const store = captureStore<readonly QueuedAction[]>(useOfflineQueue);
    const isQ = captureStore<boolean>(() => useIsQueuedOffline("r1"));
    let fired = 0;
    const off = store.subscribe(() => fired++);
    const teardown = configureOfflineQueue("user-1", runners);
    const base = fired;
    assert.equal(isQ.getSnapshot(), false);
    const ok = queueOfflineAction({ kind: "reminder.done", args: ["r1"], subject: "r1" });
    assert.equal(ok, true);
    assert.equal(fired, base + 1);
    const snap = store.getSnapshot();
    assert.equal(snap.length, 1);
    assert.equal(store.getSnapshot(), snap);
    assert.equal(isQueuedOffline("r1"), true);
    assert.equal(isQ.getSnapshot(), true);
    assert.equal(isQueuedOffline("r2"), false);
    assert.equal(env.data.size, 1, "written to localStorage under the account key");
    // Another tab writes the key: reload re-reads, emits once.
    const key = [...env.data.keys()][0];
    env.window.dispatch("storage", { key: "unrelated" });
    assert.equal(fired, base + 1);
    env.window.dispatch("storage", { key });
    assert.equal(fired, base + 2);
    assert.equal(store.getSnapshot().length, 1);
    teardown();
    off();
  });

  it("flush with nothing to send resolves without emitting", async () => {
    const store = captureStore<readonly QueuedAction[]>(useOfflineQueue);
    let fired = 0;
    const off = store.subscribe(() => fired++);
    const teardown = configureOfflineQueue("user-2", runners);
    const base = fired;
    assert.deepEqual(await flushOfflineQueue(), { sent: 0, dropped: 0, stalled: false });
    assert.equal(fired, base);
    teardown();
    off();
  });

  it("flush sends everything and empties the queue back to the EMPTY reference", async () => {
    const store = captureStore<readonly QueuedAction[]>(useOfflineQueue);
    const empty = store.getSnapshot();
    const sent: string[] = [];
    const rs = { "reminder.done": async (i: { subject: string }) => void sent.push(i.subject) } as unknown as OfflineRunners;
    const teardown = configureOfflineQueue("user-3", rs);
    queueOfflineAction({ kind: "reminder.done", args: ["x"], subject: "x" });
    assert.equal(store.getSnapshot().length, 1);
    const res = await flushOfflineQueue();
    assert.deepEqual(res, { sent: 1, dropped: 0, stalled: false });
    assert.deepEqual(sent, ["x"]);
    assert.equal(store.getSnapshot(), empty);
    teardown();
  });
});
