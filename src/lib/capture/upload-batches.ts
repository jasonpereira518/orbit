/**
 * Split one capture's files into requests small enough to reach the server.
 *
 * Vercel refuses any request body over 4.5MB before our code runs, and a capture can be
 * far bigger than that: twelve scanned pages budget 14.4MB. So a capture goes up in parts,
 * each under the per-request limit, in order, against one job (see `uploadCaptureMedia`).
 *
 * Greedy and order-preserving. Page order is the reading order of the note, so a batch
 * never reorders files to pack tighter. A file that is on its own bigger than the limit
 * cannot be split by this, and is returned separately so the caller can say so by name.
 *
 * No imports: this runs in the browser.
 */
export type UploadPlan<T> = {
  batches: T[][];
  /** Files bigger than one request can carry. Never placed in a batch. */
  oversized: T[];
};

export function planUploadBatches<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  maxBytes: number
): UploadPlan<T> {
  const batches: T[][] = [];
  const oversized: T[] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (size > maxBytes) {
      oversized.push(item);
      continue;
    }
    if (current.length && currentBytes + size > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length) batches.push(current);
  return { batches, oversized };
}

/**
 * Decoded size of a base64 string, without decoding it. The phone scan and the bulk notes
 * panel hold pages as base64, and their limit is on the files, not the encoding.
 */
export function base64DecodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** The separator `normalizeCaptureInput` joins one request's chunks with. Parts use it too. */
export const CAPTURE_CHUNK_SEPARATOR = "\n\n---\n\n";
