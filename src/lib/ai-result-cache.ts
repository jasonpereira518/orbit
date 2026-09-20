import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { aiResultCache } from "@/db/schema";
import { completeJson } from "@/lib/ai";
import type { AiOperationId } from "@/lib/ai-operations";

/**
 * AI answers keyed by exactly what was asked.
 *
 * For call sites that get asked the same question again: the recruiter classifier on every
 * re-scan (the verdict cache `recruiter-scan-state.ts` always described and nothing built),
 * the extension re-reading a profile whenever the tab comes back to it, a follow-up draft
 * sheet reopened. The key is a hash of the operation and the full prompt — system text and
 * every input — so a prompt edit or one new email is a miss by construction, and nothing
 * has to remember to bump a version.
 *
 * The cache is an optimisation and is treated as one: a read or write that fails is
 * swallowed and the call simply runs. `ORBIT_AI_RESULT_CACHE=off` disables it (the eval
 * harness does, so repeated runs measure the model rather than the cache).
 */

/** Rows older than this are pruned by the process-stalled sweep. No TTL may exceed it. */
export const AI_RESULT_CACHE_MAX_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

function cacheEnabled(): boolean {
  return process.env.ORBIT_AI_RESULT_CACHE?.trim().toLowerCase() !== "off";
}

export function aiResultCacheKey(operation: AiOperationId, parts: unknown): string {
  return createHash("sha256").update(operation).update("\0").update(JSON.stringify(parts)).digest("hex");
}

type CacheOptions<T> = {
  /** How long an answer stays good. Capped at `AI_RESULT_CACHE_MAX_DAYS`. */
  ttlDays: number;
  /** Skip the read (an explicit "Regenerate"), but still store the new answer. */
  fresh?: boolean;
  /** Only answers that pass are stored — a malformed reply must not be replayed for days. */
  accept?: (value: T) => boolean;
};

/** A validator that throws is a rejection, never a failure of the call it guards. */
function acceptSafely<T>(accept: (value: T) => boolean, value: T): boolean {
  try {
    return accept(value);
  } catch {
    return false;
  }
}

export async function withAiResultCache<T>(
  userId: string,
  operation: AiOperationId,
  keyParts: unknown,
  run: () => Promise<T>,
  opts: CacheOptions<T>
): Promise<T> {
  if (!cacheEnabled()) return run();
  const inputHash = aiResultCacheKey(operation, keyParts);
  const ttlDays = Math.min(opts.ttlDays, AI_RESULT_CACHE_MAX_DAYS);

  if (!opts.fresh) {
    try {
      const db = await getDb();
      const hit = await db.query.aiResultCache.findFirst({
        where: and(
          eq(aiResultCache.userId, userId),
          eq(aiResultCache.operation, operation),
          eq(aiResultCache.inputHash, inputHash),
          gt(aiResultCache.createdAt, new Date(Date.now() - ttlDays * DAY_MS))
        ),
        columns: { result: true },
      });
      if (hit && typeof hit.result === "object" && hit.result !== null && "v" in hit.result) {
        return (hit.result as { v: T }).v;
      }
    } catch {
      // A cache that cannot be read is a cache miss, never a failed feature.
    }
  }

  const value = await run();
  if (opts.accept && !acceptSafely(opts.accept, value)) return value;
  try {
    const db = await getDb();
    // Always an envelope, never the bare value: a bare string in a jsonb parameter is read
    // as JSON TEXT by one driver and as a JSON string by another, so a cached completion
    // came back parsed into an object on PGlite. `{ v }` round-trips the same everywhere.
    const result = { v: value };
    await db
      .insert(aiResultCache)
      .values({ userId, operation, inputHash, result })
      .onConflictDoUpdate({
        target: [aiResultCache.userId, aiResultCache.operation, aiResultCache.inputHash],
        set: { result, createdAt: new Date() },
      });
  } catch {
    // Not storing costs one repeat call later; failing here would cost the answer now.
  }
  return value;
}

/**
 * `completeJson`, answered from the cache when the identical prompt was asked before.
 * The key is the operation plus everything that shapes the reply: system, user, model
 * tier, temperature and output cap.
 */
export function cachedCompleteJson(
  userId: string,
  input: Parameters<typeof completeJson>[1],
  opts: CacheOptions<string>
): Promise<string> {
  const { system, user, temperature, maxOutputTokens, sharedPrefix } = input;
  return withAiResultCache(
    userId,
    input.operation,
    {
      system,
      user: `${sharedPrefix?.text ?? ""}${user}`,
      temperature: temperature ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
    },
    () => completeJson(userId, input),
    opts
  );
}

/** Deletes cached answers older than the longest TTL. Called by the process-stalled sweep. */
export async function pruneAiResultCache(now: Date = new Date()): Promise<void> {
  const db = await getDb();
  await db
    .delete(aiResultCache)
    .where(lt(aiResultCache.createdAt, new Date(now.getTime() - AI_RESULT_CACHE_MAX_DAYS * DAY_MS)));
}
