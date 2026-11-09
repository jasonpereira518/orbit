import { after } from "next/server";

/**
 * Waiting for a web lookup without throwing its paid work away. Its own module because
 * `web-research.ts` and `work-history-research.ts` stay free of `next/server` (smokes drive
 * them outside a request); the chat tools and meeting prep, which run inside one, use this.
 */

/** A web lookup outlived the wait its caller can afford; it is still finishing into the cache. */
export class LookupStillRunning extends Error {}

/**
 * How long a lookup may keep running after its caller stops waiting. Long enough for a slow
 * search to land in the research cache, so "finish it on Find people" is a cache hit there,
 * not a second paid search. ponytail: a fixed bound, not the route's real time left — a
 * lookup started late in a chat request is cut by the function's own maxDuration first.
 */
const KEEP_LOOKING_MS = 35_000;

/**
 * Run a web lookup, waiting at most `waitMs` for it. Past that, throw `LookupStillRunning`
 * and let the lookup finish in the background (bounded by KEEP_LOOKING_MS) — aborting it
 * threw away searches already paid for.
 */
export async function lookupKeepingLate<T>(waitMs: number, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const work = start(AbortSignal.timeout(KEEP_LOOKING_MS));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LookupStillRunning()), waitMs);
  });
  try {
    return await Promise.race([work, late]);
  } catch (err) {
    if (err instanceof LookupStillRunning) {
      const rest = work.catch(() => undefined);
      // `after` keeps the function alive for it; outside a request (a script) it just runs.
      try {
        after(() => rest);
      } catch {
        void rest;
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
