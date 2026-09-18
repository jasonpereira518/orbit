import { ERROR_SOURCES, recordErrorEvent, shouldRecordThrottled } from "@/lib/error-events";

/** Which background backfill failed — the `kind` column of the error row. */
export type BackfillKind = "embeddings" | "linkedin_timeline";

/**
 * Records a backfill that threw where only a swallowed `catch {}` would otherwise see it.
 * Returns false when the hourly latch suppressed the write. Never throws. No `next/server`
 * import: smoke scripts call this directly.
 */
export async function recordBackfillFailure(
  kind: BackfillKind,
  userId: string,
  err: unknown
): Promise<boolean> {
  if (!shouldRecordThrottled(`${ERROR_SOURCES.backfillFailed}:${kind}:${userId}`)) return false;
  await recordErrorEvent({ source: ERROR_SOURCES.backfillFailed, kind, userId, message: err });
  return true;
}
