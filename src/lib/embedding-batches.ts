/**
 * How an embedding backfill slices work into provider calls, and what it does when a call
 * fails. Pure: no database, no provider — the caller passes `embed` and `isFatal`.
 */

/** Texts per provider call. */
export const EMBED_BATCH_MAX_ITEMS = 200;

/**
 * Estimated tokens per call. OpenAI rejects an embeddings request over 300k tokens in total;
 * 200 texts at the 8,000-character cut are ~400k, so the item cap alone bounded nothing.
 */
export const EMBED_BATCH_MAX_TOKENS = 250_000;

/** Mirrors the `text.slice(0, 8000)` in `createEmbeddingsBatch` (src/lib/ai.ts). */
export const EMBED_INPUT_MAX_CHARS = 8_000;

/** ≈ 4 characters per token, on the text as it will actually be sent. */
export function estimateEmbeddingTokens(text: string): number {
  return Math.ceil(Math.min(text.length, EMBED_INPUT_MAX_CHARS) / 4);
}

/** Consecutive batches within both caps. A text over the token cap goes alone. */
export function planEmbeddingBatches<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  limits: { maxItems: number; maxTokens: number } = {
    maxItems: EMBED_BATCH_MAX_ITEMS,
    maxTokens: EMBED_BATCH_MAX_TOKENS,
  }
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost = estimateEmbeddingTokens(textOf(item));
    if (current.length > 0 && (current.length >= limits.maxItems || tokens + cost > limits.maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type BisectOutcome<T> = {
  embedded: Array<{ item: T; vector: number[] }>;
  failed: Array<{ item: T; error: unknown }>;
  /** Provider calls made, for tests and logs. */
  calls: number;
};

/**
 * Embed `items`; when a call fails, split it in half and try each half, down to single
 * items. A single item that still fails is reported, not thrown — that is the row to mark.
 *
 * `isFatal` errors (a rejected or empty key, a rate limit, a missing model) are rethrown at
 * once: bisecting would only multiply a failure that has nothing to do with the rows, and
 * the caller's existing contract — a provider failure leaves the work pending — must hold.
 */
export async function embedWithBisect<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  embed: (texts: string[]) => Promise<number[][]>,
  isFatal: (err: unknown) => boolean
): Promise<BisectOutcome<T>> {
  const outcome: BisectOutcome<T> = { embedded: [], failed: [], calls: 0 };

  async function attempt(slice: readonly T[]): Promise<void> {
    if (slice.length === 0) return;
    outcome.calls += 1;
    try {
      const vectors = await embed(slice.map(textOf));
      if (vectors.length !== slice.length || vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
        throw new Error("Incomplete embedding batch response");
      }
      slice.forEach((item, i) => outcome.embedded.push({ item, vector: vectors[i] }));
    } catch (err) {
      if (isFatal(err)) throw err;
      if (slice.length === 1) {
        outcome.failed.push({ item: slice[0], error: err });
        return;
      }
      const mid = Math.ceil(slice.length / 2);
      await attempt(slice.slice(0, mid));
      await attempt(slice.slice(mid));
    }
  }

  await attempt(items);
  return outcome;
}
