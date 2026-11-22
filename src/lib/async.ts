/**
 * Small async helpers shared by server and client code.
 *
 * No imports at all: client components import this file, so nothing server-only may be
 * pulled in. (`settle` / `unwrap` live in `settled.ts`.)
 */

/** Rejection of `withTimeout`. Callers that must tell "too slow" from "failed" use `instanceof`. */
export class TimeoutError extends Error {
  constructor(message = "timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Resolves after `ms`. With a `signal`, resolves EARLY (never rejects) when it aborts — and
 * immediately if it is already aborted — so a cancelled loop wakes and checks its own flag.
 * The timer and the abort listener are both cleaned up on either path.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Races `promise` against a timer: the promise's own outcome if it settles within `ms`,
 * otherwise a rejection with `TimeoutError(message)`. The timer is always cleared. This
 * bounds how long the CALLER waits; it cannot cancel the work underneath.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, message?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
