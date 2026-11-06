/** Local paid-to-Free detection and deferred playback decisions. */
import assert from "node:assert/strict";
import {
  downgradePlaybackDecision,
  downgradeStorageKey,
  observePlanForDowngrade,
} from "../src/lib/celebration/downgrade-detection";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
};

assert.equal(observePlanForDowngrade("a", "free", storage), null, "first Free visit is silent");
assert.equal(observePlanForDowngrade("a", "orbit", storage), null, "upgrade is silent here");
assert.equal(observePlanForDowngrade("a", "max", storage), null, "paid-to-paid is silent");
assert.equal(observePlanForDowngrade("a", "free", storage), "max", "former paid plan is retained");
assert.equal(values.get(downgradeStorageKey("a")), "free", "Free is written before playback");
assert.equal(observePlanForDowngrade("a", "free", storage), null, "same transition cannot replay");
assert.equal(observePlanForDowngrade("b", "free", storage), null, "account switch seeds independently");
assert.equal(observePlanForDowngrade("b", "lifetime", storage), null);
assert.equal(observePlanForDowngrade("b", "free", storage), "lifetime");
assert.equal(observePlanForDowngrade("a", "free", storage), null, "switching back does not replay");
assert.equal(observePlanForDowngrade("a", "orbit", storage), null);
assert.equal(observePlanForDowngrade("a", "free", storage), "orbit", "a later transition can play");
assert.equal(observePlanForDowngrade("d", "orbit", storage), null, "first paid visit seeds silently");
assert.equal(observePlanForDowngrade("d", "free", storage), "orbit", "later expiry is detected");
values.set(downgradeStorageKey("e"), "not-a-plan");
assert.equal(observePlanForDowngrade("e", "free", storage), null, "invalid history seeds silently");

assert.equal(downgradePlaybackDecision("free", false), "defer", "hidden/warp/upgrade defers");
assert.equal(downgradePlaybackDecision("free", true), "play", "visible, unobstructed Free plays");
assert.equal(downgradePlaybackDecision("max", true), "cancel", "return to paid cancels");
assert.equal(downgradePlaybackDecision("orbit", false), "cancel", "return to paid cancels while hidden");

const blockedStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
assert.equal(observePlanForDowngrade("c", "free", blockedStorage), null);

console.log("smoke-plan-downgrade: ok");
