import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as mod from "@/lib/app-pulse-store";
import { captureStore, installBrowser } from "@/lib/test-support/external-store-harness";

const env = installBrowser();
after(() => env.restore());
// `getAppPulse` is a Server Action; with no session it rejects, which `refreshPulse` swallows
// (reporting to the connectivity store). That is enough to observe the store's emissions.
const store = captureStore<mod.PulseSnapshot>(mod.useAppPulse);

describe("app-pulse-store", () => {
  it("initial and SSR snapshots are the same stable EMPTY object", () => {
    const s = store.getSnapshot();
    assert.deepEqual(s, { pulse: null, loading: false });
    assert.equal(store.getSnapshot(), s);
    assert.equal(store.getServerSnapshot(), s);
    assert.equal(store.getServerSnapshot(), store.getServerSnapshot());
  });

  it("first subscriber starts one interval and one visibility listener; the last stops them", () => {
    const off1 = store.subscribe(() => {});
    assert.equal(env.intervals.size, 1);
    assert.equal([...env.intervals.values()][0].ms, mod.PULSE_MS);
    assert.equal(env.document.count("visibilitychange"), 1);
    const off2 = store.subscribe(() => {});
    assert.equal(env.intervals.size, 1);
    off1();
    assert.equal(env.intervals.size, 1);
    off2();
    assert.equal(env.intervals.size, 0);
    assert.equal(env.document.count("visibilitychange"), 0);
  });

  it("refresh emits loading:true then loading:false (new object each, stable between); shared while in flight", async () => {
    const seen: mod.PulseSnapshot[] = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot()));
    const initial = store.getSnapshot();
    const a = mod.refreshPulse();
    const b = mod.refreshPulse();
    assert.equal(a, b, "ambient callers share the in-flight request");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].loading, true);
    assert.notEqual(seen[0], initial);
    assert.equal(store.getSnapshot(), seen[0]);
    await a;
    assert.equal(seen.length, 2);
    assert.equal(seen[1].loading, false);
    assert.equal(seen[1].pulse, null);
    assert.equal(store.getSnapshot(), seen[1]);
    off();
  });

  it("the last unsubscribe resets the snapshot to the EMPTY constant without emitting", () => {
    let fired = 0;
    const off = store.subscribe(() => fired++);
    void mod.refreshPulse();
    assert.equal(fired, 1);
    assert.equal(store.getSnapshot().loading, true);
    off();
    assert.equal(fired, 1, "reset does not notify");
    assert.deepEqual(store.getSnapshot(), { pulse: null, loading: false });
    assert.equal(store.getSnapshot(), store.getServerSnapshot());
  });
});
