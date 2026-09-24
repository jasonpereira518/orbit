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
 *   - an entry is used once (`take` removes it) and only while fresh;
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

/** What `take` hands back: the value itself when the read already landed, else its promise. */
export type TakenThread<T> = { value: T } | { promise: Promise<T> };

type Entry<T> = {
  at: number;
  promise: Promise<T>;
  /** Set when the read resolves, so a click can apply it without awaiting anything. */
  value?: T;
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

export const THREAD_PREFETCH_FRESH_MS = 30_000;
export const THREAD_PREFETCH_DELAY_MS = 80;

export function createThreadPrefetcher<T extends ThreadPrefetchResult>(
  fetchThread: (id: string) => Promise<T>,
  {
    freshMs = THREAD_PREFETCH_FRESH_MS,
    delayMs = THREAD_PREFETCH_DELAY_MS,
    now = () => Date.now(),
  }: { freshMs?: number; delayMs?: number; now?: () => number } = {}
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

  function start(id: string) {
    if (fresh(entries.get(id))) return;
    if (inFlight) {
      queued = id;
      return;
    }
    inFlight = true;
    const entry: Entry<T> = { at: now(), promise: fetchThread(id) };
    entries.set(id, entry);
    entry.promise
      .then(
        (value) => {
          // A result for some other thread is never kept under this id.
          if (value?.thread?.id === id) entry.value = value;
          else if (entries.get(id) === entry) entries.delete(id);
        },
        () => {
          if (entries.get(id) === entry) entries.delete(id);
        }
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
      if (!fresh(entry)) return null;
      if (entry.value !== undefined) return { value: entry.value };
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
