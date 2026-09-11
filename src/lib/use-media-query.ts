"use client";

import { useSyncExternalStore } from "react";

/**
 * One `MediaQueryList` per distinct query, shared across every caller.
 *
 * `useSyncExternalStore` re-subscribes whenever `subscribe` changes identity, so an
 * inline closure would tear down and rebuild the listener on every render. Caching the
 * pair here keeps that identity stable per query and means N components watching the
 * same breakpoint cost one listener, not N.
 */
type Entry = {
  mq: MediaQueryList;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => boolean;
};

const entries = new Map<string, Entry>();

function entryFor(query: string): Entry {
  const cached = entries.get(query);
  if (cached) return cached;

  const mq = window.matchMedia(query);
  const entry: Entry = {
    mq,
    /**
     * Three signals, not one.
     *
     * `change` on the MediaQueryList is the correct event and the one a real rotation
     * fires. `resize` and `orientationchange` are a deliberate backstop for the cases
     * where it is not delivered — some embedded and remote-controlled browsers drive the
     * viewport without dispatching it. The cost is negligible: `useSyncExternalStore`
     * compares the snapshot and skips the render when the answer has not moved, so a
     * redundant notification is one boolean read.
     *
     * Belt and braces is worth it for this hook specifically, because a caller left on a
     * stale `false` is a phone running the renderer it cannot afford.
     */
    subscribe: (cb) => {
      mq.addEventListener("change", cb);
      window.addEventListener("resize", cb);
      window.addEventListener("orientationchange", cb);
      return () => {
        mq.removeEventListener("change", cb);
        window.removeEventListener("resize", cb);
        window.removeEventListener("orientationchange", cb);
      };
    },
    getSnapshot: () => mq.matches,
  };
  entries.set(query, entry);
  return entry;
}

// Stable no-op identities for the server pass, where `window` does not exist and
// `entryFor` cannot run. Defined once so they never change identity either.
const noopSubscribe = () => () => {};
const serverSnapshot = () => false;

/**
 * Whether a media query currently matches. Server-renders as false — use it to gate
 * client-only behaviour, never layout, or the first paint will disagree with the markup.
 */
export function useMediaQuery(query: string): boolean {
  const isBrowser = typeof window !== "undefined";
  const entry = isBrowser ? entryFor(query) : null;
  return useSyncExternalStore(
    entry ? entry.subscribe : noopSubscribe,
    entry ? entry.getSnapshot : serverSnapshot,
    serverSnapshot
  );
}
