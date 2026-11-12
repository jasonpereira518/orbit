/**
 * Test-only helpers for the client external stores (`useSyncExternalStore` modules).
 *
 * - `captureStore(hook)` runs a store's hook outside a render and returns the exact
 *   `subscribe` / `getSnapshot` / `getServerSnapshot` it hands to React, so a test can
 *   assert snapshot identity and subscription behaviour without a DOM or a renderer.
 * - `installBrowser()` stubs the minimal `window` / `document` / `localStorage` /
 *   `navigator` a store touches, with an event registry and recorded intervals.
 */
import * as React from "react";

export type StoreContract<T> = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
};

export function captureStore<T>(hook: () => unknown): StoreContract<T> {
  const internals = (React as unknown as Record<string, { H: unknown }>)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prev = internals.H;
  let captured: StoreContract<T> | null = null;
  internals.H = {
    useSyncExternalStore(
      subscribe: StoreContract<T>["subscribe"],
      getSnapshot: StoreContract<T>["getSnapshot"],
      getServerSnapshot: StoreContract<T>["getServerSnapshot"]
    ) {
      captured = { subscribe, getSnapshot, getServerSnapshot };
      return getSnapshot();
    },
  };
  try {
    hook();
  } finally {
    internals.H = prev;
  }
  if (!captured) throw new Error("hook did not call useSyncExternalStore");
  return captured;
}

type Handler = (event: unknown) => void;

function eventTarget() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    addEventListener(type: string, fn: Handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Handler) {
      handlers.get(type)?.delete(fn);
    },
    /** How many handlers are attached for `type`. */
    count(type: string) {
      return handlers.get(type)?.size ?? 0;
    },
    dispatch(type: string, event: unknown = {}) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
    },
  };
}

export function installBrowser(opts: { online?: boolean } = {}) {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    localStorage: g.localStorage,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const win = eventTarget();
  const doc = eventTarget();
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const windowStub = Object.assign(win, {
    localStorage,
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id: number) => void intervals.delete(id),
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: number) => void timeouts.delete(id),
  });
  const documentStub = Object.assign(doc, { visibilityState: "visible" });
  g.window = windowStub;
  g.document = documentStub;
  g.localStorage = localStorage;
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: opts.online ?? true },
    configurable: true,
    writable: true,
  });
  return {
    window: windowStub,
    document: documentStub,
    localStorage,
    data,
    /** Live intervals started through `window.setInterval`. */
    intervals,
    /** Pending timeouts started through `window.setTimeout` (never fired automatically). */
    timeouts,
    restore() {
      g.window = saved.window;
      g.document = saved.document;
      g.localStorage = saved.localStorage;
      if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
      if (saved.window === undefined) delete g.window;
      if (saved.document === undefined) delete g.document;
      if (saved.localStorage === undefined) delete g.localStorage;
    },
  };
}
