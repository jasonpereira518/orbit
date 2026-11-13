import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as mod from "@/lib/connectivity-store";
import { INITIAL_CONNECTIVITY, type ConnectivityState } from "@/lib/connectivity";
import { captureStore, installBrowser } from "@/lib/test-support/external-store-harness";

const env = installBrowser();
const g = globalThis as Record<string, unknown>;
const realFetch = g.fetch;
let probeResult: "ok" | "fail" = "ok";
let probes = 0;
g.fetch = async () => {
  probes++;
  if (probeResult === "fail") throw new TypeError("Failed to fetch");
  return new Response(null, { status: 200 });
};
after(() => {
  env.restore();
  g.fetch = realFetch;
});
const tick = () => new Promise<void>((r) => setImmediate(r));

const store = captureStore<ConnectivityState>(mod.useConnectivity);

describe("connectivity-store", () => {
  it("SSR snapshot and the pre-subscribe snapshot are the INITIAL constant", () => {
    assert.equal(store.getServerSnapshot(), INITIAL_CONNECTIVITY);
    assert.equal(store.getSnapshot(), INITIAL_CONNECTIVITY);
    assert.equal(env.window.count("offline"), 0, "nothing attached before a subscriber");
  });

  let fired = 0;
  let off: () => void = () => {};
  let reconnects = 0;

  it("first subscribe starts browser listeners once; a second subscriber adds none", () => {
    off = store.subscribe(() => fired++);
    assert.equal(env.window.count("offline"), 1);
    assert.equal(env.window.count("online"), 1);
    assert.equal(env.document.count("visibilitychange"), 1);
    const off2 = store.subscribe(() => {});
    assert.equal(env.window.count("offline"), 1);
    off2();
    assert.equal(env.window.count("offline"), 1, "still one subscriber left");
    assert.equal(store.getSnapshot(), INITIAL_CONNECTIVITY);
    assert.equal(fired, 0);
    assert.equal(mod.isOffline(), false);
  });

  it("browser offline event: one emit, new stable snapshot, isOffline true", () => {
    (g.navigator as { onLine: boolean }).onLine = false;
    env.window.dispatch("offline");
    assert.equal(fired, 1);
    const s = store.getSnapshot();
    assert.equal(s.status, "offline");
    assert.equal(store.getSnapshot(), s);
    assert.equal(mod.getConnectivity(), s);
    assert.equal(mod.isOffline(), true);
    // Current behaviour: the reducer returns a fresh object for a repeated offline event, so
    // it emits again (a new reference, same content).
    env.window.dispatch("offline");
    assert.equal(fired, 2);
    const s2 = store.getSnapshot();
    assert.notEqual(s2, s);
    assert.deepEqual(s2, s);
    // request_ok cannot lift "offline": reportRequestOk dispatches, reducer returns the same state.
    mod.reportRequestOk();
    assert.equal(store.getSnapshot(), s2);
    assert.equal(fired, 2);
  });

  it("coming back online probes, emits, runs reconnect listeners once, and lands on INITIAL", async () => {
    const offReconnect = mod.onReconnect(() => reconnects++);
    (g.navigator as { onLine: boolean }).onLine = true;
    probeResult = "ok";
    env.window.dispatch("online");
    assert.equal(store.getSnapshot().status, "unreachable");
    assert.equal(fired, 3);
    await tick();
    assert.equal(probes, 1);
    assert.equal(store.getSnapshot(), INITIAL_CONNECTIVITY);
    assert.equal(fired, 4);
    assert.equal(reconnects, 1);
    offReconnect();
  });

  it("a failed probe is a new state each time (failedProbes climbs) and schedules the next", async () => {
    probeResult = "fail";
    const before = fired;
    assert.equal(mod.reportRequestError(new TypeError("Failed to fetch")), true);
    await tick();
    assert.equal(store.getSnapshot().status, "unreachable");
    assert.equal(store.getSnapshot().failedProbes, 1);
    assert.equal(fired, before + 1);
    assert.equal(env.timeouts.size, 1, "next probe scheduled");
    assert.equal(mod.reportRequestError(new Error("not network")), false);
    // Real traffic getting through clears it at once.
    mod.reportRequestOk();
    assert.equal(store.getSnapshot(), INITIAL_CONNECTIVITY);
    assert.equal(fired, before + 2);
    assert.equal(env.timeouts.size, 0, "probe timer cleared once online");
    // ...and calling it again when online does nothing.
    mod.reportRequestOk();
    assert.equal(fired, before + 2);
  });

  it("last unsubscribe stops (listeners removed) unless a reconnect listener is still held", () => {
    const offReconnect = mod.onReconnect(() => {});
    off();
    assert.equal(env.window.count("offline"), 1, "reconnect listener keeps it running");
    offReconnect();
    assert.equal(env.window.count("offline"), 0);
    assert.equal(env.window.count("online"), 0);
    assert.equal(env.document.count("visibilitychange"), 0);
  });

  it("subscribers fire exactly once per emit and not after unsubscribe", () => {
    let a = 0;
    let b = 0;
    const offA = store.subscribe(() => a++);
    const offB = store.subscribe(() => b++);
    env.window.dispatch("offline");
    assert.deepEqual([a, b], [1, 1]);
    offA();
    env.window.dispatch("offline"); // emits again (fresh object); only B hears it
    (g.navigator as { onLine: boolean }).onLine = true;
    assert.deepEqual([a, b], [1, 2]);
    offB();
    assert.equal(env.window.count("offline"), 0);
  });
});
