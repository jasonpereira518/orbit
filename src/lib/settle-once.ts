/**
 * A promise whose resolve/reject can safely be called more than once, or not at all.
 *
 * Built for callback-based browser APIs — Google's Picker is the first user — that call
 * back on their own schedule: multiple times for one outcome, or never, if the thing
 * they were loading (a script, an iframe) failed in a way that never reaches the
 * callback. Wiring `new Promise((resolve, reject) => …)` directly to such a callback
 * either double-settles (harmless, but the second call is a silent no-op that's easy to
 * mistake for a bug) or hangs forever waiting for a callback that isn't coming. This
 * makes "settle exactly once, and only once" the caller's whole job.
 */
export function createSettler<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  settled: () => boolean;
} {
  let settled = false;
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve(value: T) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject(err: unknown) {
      if (settled) return;
      settled = true;
      rejectFn(err);
    },
    settled: () => settled,
  };
}
