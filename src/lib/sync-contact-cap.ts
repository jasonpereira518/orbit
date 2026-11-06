/**
 * Bookkeeping for people the plan's contact cap held back during a contacts sync.
 *
 * A synced address book routinely holds more people than a free plan allows. The ones that do
 * not fit are not lost, but a delta cursor has moved past them — so without this they would be
 * unreachable even after an upgrade. Two small rules fix that, and both live on the cursor
 * that already exists rather than in a new table:
 *
 *   1. The count is kept, so the app can say "214 more waiting" instead of silence.
 *   2. When a later run finds room again, it reads the whole book from scratch. That is the
 *      whole "upgrade" mechanism: no plan-change hook, no separate queue — the sync notices.
 *
 * The count is a floor, not an exact figure: a delta run that re-meets a person still held
 * back counts them once more. It only has to be honest about "at least this many".
 */

type CapCursor = { blockedByPlan?: number | null };

/**
 * The cursor a contacts phase should START from.
 *
 * `headroom` is the ingest context's remaining allowance (`null` = unlimited). If people were
 * held back and there is now room, drop the cursor so the next read covers everyone again —
 * `ingestPeople` matches the people already imported, so this creates only the ones that were
 * missing. With no room, keep the cursor: re-reading a whole book every half hour to be turned
 * away again would be pure cost.
 */
export function startCursorForCap<T extends CapCursor>(
  cursor: T | null,
  headroom: number | null
): T | null {
  const held = cursor?.blockedByPlan ?? 0;
  if (held > 0 && (headroom === null || headroom > 0)) return null;
  return cursor;
}

/** The held-back count a phase starts counting from: a fresh read starts at zero. */
export function initialBlockedCount(cursor: CapCursor | null): number {
  return cursor?.blockedByPlan ?? 0;
}

/** Stamp the running count onto a cursor. Zero is stored as `null` — "none waiting". */
export function withBlockedCount<T extends object>(
  cursor: T,
  blocked: number
): T & { blockedByPlan: number | null } {
  return { ...cursor, blockedByPlan: blocked > 0 ? blocked : null };
}
