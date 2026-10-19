/**
 * Reject a promise that has not settled after `ms`. Four settings cards (API keys,
 * webhooks, calendar feed, email) each carried their own copy of this, with their own
 * timeout message; this is the one copy. The rejection carries `TIMED_OUT` so a caller
 * can tell a slow server from a failed one.
 */
export const TIMED_OUT = "timed_out";

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string = TIMED_OUT): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
