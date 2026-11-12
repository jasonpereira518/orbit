import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExternalStore, listen } from "@/lib/create-external-store";

describe("createExternalStore", () => {
  it("hands back the module's own snapshot getters untouched (identity is the module's job)", () => {
    const a = { n: 1 };
    const server = { n: 0 };
    let current = a;
    const store = createExternalStore({ getSnapshot: () => current, getServerSnapshot: () => server });
    assert.equal(store.getSnapshot(), a);
    assert.equal(store.getSnapshot(), a);
    current = { n: 2 };
    assert.equal(store.getSnapshot(), current);
    assert.equal(store.getServerSnapshot(), server);
  });

  it("emit calls each subscriber once, in order; unsubscribe stops it; double unsubscribe is harmless", () => {
    const store = createExternalStore({ getSnapshot: () => 1, getServerSnapshot: () => 0 });
    const calls: string[] = [];
    const offA = store.subscribe(() => calls.push("a"));
    const offB = store.subscribe(() => calls.push("b"));
    store.emit();
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(store.size(), 2);
    offA();
    offA();
    store.emit();
    assert.deepEqual(calls, ["a", "b", "b"]);
    assert.equal(store.size(), 1);
    offB();
    store.emit();
    assert.equal(calls.length, 3);
    assert.equal(store.size(), 0);
  });

  it("the same function subscribed twice is one listener (Set semantics, as before)", () => {
    const store = createExternalStore({ getSnapshot: () => 1, getServerSnapshot: () => 0 });
    let n = 0;
    const l = () => n++;
    store.subscribe(l);
    store.subscribe(l);
    store.emit();
    assert.equal(n, 1);
    assert.equal(store.size(), 1);
  });

  it("lifecycle hooks: beforeSubscribe every time, onSubscribe/onUnsubscribe with the new count", () => {
    const log: string[] = [];
    const store = createExternalStore({
      getSnapshot: () => 1,
      getServerSnapshot: () => 0,
      beforeSubscribe: () => log.push("before"),
      onSubscribe: (c) => log.push(`sub${c}`),
      onUnsubscribe: (c) => log.push(`unsub${c}`),
    });
    const off1 = store.subscribe(() => {});
    const off2 = store.subscribe(() => {});
    off1();
    off2();
    assert.deepEqual(log, ["before", "sub1", "before", "sub2", "unsub1", "unsub0"]);
  });

  it("subscribe keeps one identity, and importing/creating a store touches no browser globals", () => {
    assert.equal(typeof (globalThis as { window?: unknown }).window, "undefined");
    const store = createExternalStore({ getSnapshot: () => 1, getServerSnapshot: () => 0 });
    const { subscribe } = store;
    const off = subscribe(() => {}); // detached method still works
    off();
    assert.equal(store.size(), 0);
  });
});

describe("listen", () => {
  it("attaches and returns a detach function", () => {
    const seen: string[] = [];
    const target = {
      handlers: new Set<EventListener>(),
      addEventListener(type: string, fn: EventListener) {
        seen.push(`add:${type}`);
        this.handlers.add(fn);
      },
      removeEventListener(type: string, fn: EventListener) {
        seen.push(`remove:${type}`);
        this.handlers.delete(fn);
      },
    };
    const off = listen(target, "storage", () => {});
    assert.equal(target.handlers.size, 1);
    off();
    assert.equal(target.handlers.size, 0);
    assert.deepEqual(seen, ["add:storage", "remove:storage"]);
  });
});
