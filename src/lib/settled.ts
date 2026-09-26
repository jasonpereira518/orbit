/**
 * Start independent reads together, consume them in the order the serial code did.
 *
 * `Promise.all` over two reads that used to run one after the other changes more than
 * latency: if both fail it rejects with whichever failed FIRST IN TIME, and if the code
 * between them could return or throw early (a not-found, an ownership gate), the second
 * read's rejection is left unhandled. `settle` never rejects, and `unwrap` rethrows the
 * captured error at the point the serial code would have awaited that read — so the error
 * a caller sees, and every early return, stay exactly what they were.
 */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/** Starts (or wraps) a promise so it can be awaited later without an unhandled rejection. */
export function settle<T>(promise: PromiseLike<T>): Promise<Settled<T>> {
  return Promise.resolve(promise).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

/** The value, or the original error rethrown — at the caller's chosen point. */
export function unwrap<T>(result: Settled<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
