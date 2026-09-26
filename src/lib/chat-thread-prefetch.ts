/**
 * Loading a saved chat before the click that asks for it.
 *
 * Opening a thread from history is a `getChatThread` round trip, and the panel shows a
 * spinner for all of it. The pointer resting on a history row (or keyboard focus reaching it)
 * is a strong hint that the click is coming, so the same read starts then and the click picks
 * up its result — usually already settled, so the thread swaps in with no spinner at all.
 *
 * The rules that keep this from ever showing the wrong thing:
 *   - entries are keyed by thread id, and a result whose `thread.id` is not the key is refused;
 *   - an entry is used once (`take` removes it);
 *   - a read older than `freshMs` is never trusted as it stands: `take` hands it back marked
 *     `fresh: false`, to show at once while the caller reads the thread again and swaps in
 *     the current copy. Past `keepMs` it is not shown at all;
 *   - a failed prefetch leaves nothing behind, so the click loads the ordinary way;
 *   - the panel `forget`s a thread whenever it could have changed under the entry — the one
 *     it is leaving and the one it lands on, and one being deleted.
 *
 * Server Actions go out one at a time per tab, so a pointer sweeping down the rail must not
 * queue a read per row in front of the real click. At most one prefetch is in flight; while
 * it runs, only the LATEST hovered row waits behind it, and a hover has to rest `delayMs`
 * before it counts at all.
 *
 * No React and no server imports: the fetcher is handed in, which is also what makes this
 * testable on its own.
 */

export type ThreadPrefetchResult = { thread: { id: string } };

/**
 * What `take` hands back:
 *   - `{ value, fresh: true }` — read within `freshMs`; use it as the thread;
 *   - `{ value, fresh: false, promise? }` — an older read: show it now, then revalidate, with
 *     `promise` (a newer read already in flight) when there is one;
 *   - `{ promise }` — the read has not landed yet; await it.
 */
export type TakenThread<T> =
  | { value: T; fresh: true }
  | { value: T; fresh: false; promise?: Promise<T> }
  | { promise: Promise<T> };

type Entry<T> = {
  at: number;
  promise: Promise<T>;
  /** Set when the read resolves, so a click can apply it without awaiting anything. */
  value?: T;
  /** The last landed read this one is replacing, with its start time — shown while it runs. */
  previous?: { value: T; at: number };
};

export type ThreadPrefetcher<T extends ThreadPrefetchResult> = {
  /** The pointer came to rest on a row: prefetch after `delayMs` unless `leave` comes first. */
  hover: (id: string) => void;
  /** The pointer left before the delay ran out. */
  leave: () => void;
  /** Focus or touch: intent is unambiguous, prefetch now. */
  prefetch: (id: string) => void;
  /** The prefetched read for `id` if one is fresh, removing it. `null` means load normally. */
  take: (id: string) => TakenThread<T> | null;
  /** Drop whatever is held for `id` — it may no longer match the server. */
  forget: (id: string | null | undefined) => void;
  /** Cancel the pending hover timer (on unmount). */
  dispose: () => void;
};

/** A read this recent is the thread as it stands; matches `FRESH_ON_ARRIVAL_MS` for pages. */
export const THREAD_PREFETCH_FRESH_MS = 2_000;
/** An older read is still worth showing for the instant it takes to re-read, up to this age. */
export const THREAD_PREFETCH_KEEP_MS = 5 * 60_000;
export const THREAD_PREFETCH_DELAY_MS = 80;
/**
 * Settled reads held at once. Each is a whole thread — messages, evidence, actions — and a
 * pointer sweeping the rail would otherwise leave one behind per row for as long as the
 * panel stays mounted, since only `take` and `forget` ever removed them.
 */
export const THREAD_PREFETCH_MAX_HELD = 8;

export function createThreadPrefetcher<T extends ThreadPrefetchResult>(
  fetchThread: (id: string) => Promise<T>,
  {
    freshMs = THREAD_PREFETCH_FRESH_MS,
    keepMs = THREAD_PREFETCH_KEEP_MS,
    delayMs = THREAD_PREFETCH_DELAY_MS,
    now = () => Date.now(),
  }: { freshMs?: number; keepMs?: number; delayMs?: number; now?: () => number } = {}
): ThreadPrefetcher<T> {
  const entries = new Map<string, Entry<T>>();
  let inFlight = false;
  let queued: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fresh = (entry: Entry<T> | undefined): entry is Entry<T> =>
    !!entry && now() - entry.at < freshMs;

  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** The newest landed read held for `id`, whether it is the entry itself or what it replaces. */
  function landed(entry: Entry<T> | undefined): { value: T; at: number } | undefined {
    if (!entry) return undefined;
    if (entry.value !== undefined) return { value: entry.value, at: entry.at };
    return entry.previous;
  }

  /** Drop reads too old for `take` to show, then the oldest past the cap. Never one in flight. */
  function evict() {
    const settled: [string, number][] = [];
    for (const [key, entry] of entries) {
      if (entry.value === undefined) continue;
      if (now() - entry.at >= keepMs) entries.delete(key);
      else settled.push([key, entry.at]);
    }
    if (settled.length <= THREAD_PREFETCH_MAX_HELD) return;
    settled.sort((a, b) => a[1] - b[1]);
    for (const [key] of settled.slice(0, settled.length - THREAD_PREFETCH_MAX_HELD)) {
      entries.delete(key);
    }
  }

  function start(id: string) {
    if (fresh(entries.get(id))) return;
    if (inFlight) {
      queued = id;
      return;
    }
    inFlight = true;
    evict();
    const before = landed(entries.get(id));
    const entry: Entry<T> = { at: now(), promise: fetchThread(id), previous: before };
    entries.set(id, entry);
    // If this re-read fails, the older read it replaced stays usable (as stale) on its own.
    const fallBack = () => {
      if (entries.get(id) !== entry) return;
      if (before) entries.set(id, { at: before.at, promise: Promise.resolve(before.value), value: before.value });
      else entries.delete(id);
    };
    entry.promise
      .then(
        (value) => {
          // A result for some other thread is never kept under this id.
          if (value?.thread?.id === id) {
            entry.value = value;
            entry.previous = undefined;
          } else fallBack();
        },
        fallBack
      )
      .finally(() => {
        inFlight = false;
        const next = queued;
        queued = null;
        if (next) start(next);
      });
  }

  return {
    hover(id) {
      cancelTimer();
      if (delayMs <= 0) return start(id);
      timer = setTimeout(() => {
        timer = null;
        start(id);
      }, delayMs);
    },
    leave: cancelTimer,
    prefetch(id) {
      cancelTimer();
      start(id);
    },
    take(id) {
      const entry = entries.get(id);
      entries.delete(id);
      if (queued === id) queued = null;
      if (!entry) return null;
      if (entry.value !== undefined) {
        const age = now() - entry.at;
        if (age < freshMs) return { value: entry.value, fresh: true };
        if (age < keepMs) return { value: entry.value, fresh: false };
        return null;
      }
      // Still in flight. An older read of the same thread, if one is held, shows meanwhile.
      if (entry.previous && now() - entry.previous.at < keepMs) {
        return { value: entry.previous.value, fresh: false, promise: entry.promise };
      }
      if (!fresh(entry)) return null;
      return { promise: entry.promise };
    },
    forget(id) {
      if (!id) return;
      entries.delete(id);
      if (queued === id) queued = null;
    },
    dispose() {
      cancelTimer();
      queued = null;
    },
  };
}
