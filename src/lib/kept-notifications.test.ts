import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as mod from "@/lib/kept-notifications";
import { captureStore, installBrowser } from "@/lib/test-support/external-store-harness";

const env = installBrowser();
after(() => env.restore());

const STORAGE_KEY = "orbit:kept-notifications:v1";
// Seed the mirror BEFORE the module's first hydrate (which happens on first subscribe/keep).
const now = Date.now();
env.data.set(
  STORAGE_KEY,
  JSON.stringify([
    { id: "old", tone: "error", title: "Seeded", at: now - 1000 },
    { id: "bad", tone: "error" },
  ])
);

const store = captureStore<mod.KeptNotification[]>(mod.useKeptNotifications);

describe("kept-notifications store", () => {
  it("SSR snapshot is a stable empty array; client snapshot is empty before first subscribe", () => {
    const server = store.getServerSnapshot();
    assert.equal(server.length, 0);
    assert.equal(store.getServerSnapshot(), server);
    assert.equal(store.getSnapshot().length, 0, "hydration is deferred until subscribe");
    assert.equal(store.getSnapshot(), store.getSnapshot());
  });

  let fired = 0;
  let off: () => void = () => {};

  it("first subscribe hydrates the mirror, validating rows, and attaches one storage listener", () => {
    assert.equal(env.window.count("storage"), 0);
    off = store.subscribe(() => fired++);
    assert.equal(fired, 0, "hydration does not emit");
    assert.equal(env.window.count("storage"), 1);
    const s = store.getSnapshot();
    assert.deepEqual(s.map((n) => n.id), ["old"]);
    assert.equal(store.getSnapshot(), s);
    const off2 = store.subscribe(() => {});
    assert.equal(env.window.count("storage"), 1, "one listener for the store, not per subscriber");
    off2();
    assert.equal(env.window.count("storage"), 1);
  });

  it("keepNotification emits once, changes the snapshot, persists, is idempotent per id", () => {
    const before = store.getSnapshot();
    mod.keepNotification({ id: "n1", tone: "error", title: "Couldn't save", at: now });
    assert.equal(fired, 1);
    const s = store.getSnapshot();
    assert.notEqual(s, before);
    assert.equal(store.getSnapshot(), s);
    assert.deepEqual(s.map((n) => n.id), ["n1", "old"], "newest first");
    assert.equal(s[0].read, false);
    assert.equal(JSON.parse(env.data.get(STORAGE_KEY)!).length, 2);

    mod.keepNotification({ id: "n1", tone: "error", title: "Couldn't save" });
    assert.equal(fired, 1, "same id: no emit");
    assert.equal(store.getSnapshot(), s);
  });

  it("an identical title+tone replaces the earlier row", () => {
    mod.keepNotification({ id: "n2", tone: "error", title: "Couldn't save", at: now + 5 });
    assert.equal(fired, 2);
    assert.deepEqual(store.getSnapshot().map((n) => n.id), ["n2", "old"]);
  });

  it("actions: live closure vs none, run once", () => {
    let ran = 0;
    mod.keepNotification({ id: "n3", tone: "action", title: "Deleted", at: now + 10, onAction: () => ran++ });
    assert.equal(fired, 3);
    assert.equal(mod.hasLiveAction("n3"), true);
    assert.equal(mod.hasLiveAction("old"), false);
    mod.runKeptAction("n3");
    assert.equal(ran, 1);
  });

  it("markKeptNotificationsRead emits only when something changed", () => {
    mod.markKeptNotificationsRead();
    assert.equal(fired, 4);
    assert.ok(store.getSnapshot().every((n) => n.read));
    const s = store.getSnapshot();
    mod.markKeptNotificationsRead();
    assert.equal(fired, 4);
    assert.equal(store.getSnapshot(), s);
  });

  it("dismiss / clear emit only when they remove something", () => {
    mod.dismissKeptNotification("nope");
    assert.equal(fired, 4);
    mod.dismissKeptNotification("n3");
    assert.equal(fired, 5);
    assert.equal(mod.hasLiveAction("n3"), false);
    assert.deepEqual(store.getSnapshot().map((n) => n.id), ["n2", "old"]);
    mod.clearKeptNotifications();
    assert.equal(fired, 6);
    const empty = store.getSnapshot();
    assert.equal(empty.length, 0);
    mod.clearKeptNotifications();
    assert.equal(fired, 6);
    assert.equal(store.getSnapshot(), empty);
  });

  it("a storage event for the key re-reads the mirror and emits once; other keys are ignored", () => {
    env.window.dispatch("storage", { key: "something-else" });
    assert.equal(fired, 6);
    env.data.set(STORAGE_KEY, JSON.stringify([{ id: "other-tab", tone: "error", title: "From tab 2", at: now }]));
    env.window.dispatch("storage", { key: STORAGE_KEY });
    assert.equal(fired, 7);
    const s = store.getSnapshot();
    assert.deepEqual(s.map((n) => n.id), ["other-tab"]);
    assert.equal(store.getSnapshot(), s);
    // The other tab removed the key outright.
    env.data.delete(STORAGE_KEY);
    env.window.dispatch("storage", { key: STORAGE_KEY });
    assert.equal(fired, 8);
    assert.equal(store.getSnapshot().length, 0);
  });

  it("last unsubscribe removes the storage listener; unsubscribed callbacks no longer fire", () => {
    off();
    assert.equal(env.window.count("storage"), 0);
    const before = fired;
    mod.keepNotification({ id: "n9", tone: "error", title: "After unsub", at: now });
    assert.equal(fired, before);
    assert.equal(store.getSnapshot().length, 1, "state still updates; just nobody is told");
  });
});
