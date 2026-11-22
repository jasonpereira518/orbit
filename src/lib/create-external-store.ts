/**
 * The shared plumbing behind the module-level client stores read with `useSyncExternalStore`
 * (`app-pulse-store`, `background-jobs`, `capture/job-store`, `connectivity-store`,
 * `kept-notifications`, `offline-queue-store`, `meeting-nudge-store`): a listener set,
 * `subscribe`, `emit`, and the snapshot getters React asks for.
 *
 * What it does NOT do is own the snapshot. Each module keeps its state in its own variable and
 * hands over `getSnapshot`, because the one rule `useSyncExternalStore` imposes is that
 * `getSnapshot` returns a referentially stable value until something changes, and each module
 * guarantees that its own way (a cached array rebuilt in `emit`, a replaced immutable object,
 * a reducer that returns the same state). The factory never reads, caches or compares the
 * snapshot: the value a module returned before the refactor is the value it returns now.
 *
 * Safe to import anywhere, SSR included: nothing here touches `window` or `document`, and the
 * module has no side effects at load. Browser listeners and timers belong in the hooks below,
 * which only run once something subscribes (on the client).
 */

export type ExternalStoreOptions<T> = {
  /** Must return the same reference until the module changes its state. */
  getSnapshot: () => T;
  /** The value used on the server and during hydration; must also be stable. */
  getServerSnapshot: () => T;
  /** Runs at the start of EVERY `subscribe`, before the listener is added (lazy hydrate / start). */
  beforeSubscribe?: () => void;
  /** Runs after a listener was added, with the listener count now. `count === 1`: the first one. */
  onSubscribe?: (count: number) => void;
  /** Runs after a listener was removed, with the count now. `count === 0`: the last one left. */
  onUnsubscribe?: (count: number) => void;
};

export type ExternalStore<T> = {
  /** Stable identity for the life of the store, as `useSyncExternalStore` wants. */
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  /** Call every listener once, in subscription order. The module updates its snapshot first. */
  emit: () => void;
  /** How many distinct listeners are subscribed right now. */
  size: () => number;
};

export function createExternalStore<T>(options: ExternalStoreOptions<T>): ExternalStore<T> {
  const { getSnapshot, getServerSnapshot, beforeSubscribe, onSubscribe, onUnsubscribe } = options;
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      beforeSubscribe?.();
      listeners.add(listener);
      onSubscribe?.(listeners.size);
      return () => {
        listeners.delete(listener);
        onUnsubscribe?.(listeners.size);
      };
    },
    getSnapshot,
    getServerSnapshot,
    emit() {
      for (const listener of listeners) listener();
    },
    size: () => listeners.size,
  };
}

/**
 * Attach a DOM event listener (`visibilitychange` on `document`, `storage` on `window`) and
 * get back the function that detaches it. For use inside `onSubscribe` / `onUnsubscribe`,
 * never at module load.
 */
export function listen<E extends Event = Event>(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  type: string,
  handler: (event: E) => void
): () => void {
  target.addEventListener(type, handler as EventListener);
  return () => target.removeEventListener(type, handler as EventListener);
}
