/**
 * Hand-dragged star positions: what to render with, and what to keep.
 *
 * These two are separate operations and conflating them was a real bug. The graph renders
 * from a map pruned to the contacts actually in the payload — `computeSunExtents` walks the
 * override map, so an id with no node would inflate the fit extent and zoom the user out for
 * a star that is not there. But the payload is not the whole network: it is capped at
 * `GRAPH_PREVIEW_CONTACT_CAP` on the dashboard, and narrowed further by the constellation
 * filter. Persisting that pruned map — which is what `applyGraphPayload` used to do whenever
 * the sizes differed — deleted the saved position of every contact the current view happened
 * to leave out, permanently, on a refetch that fires on every window focus.
 *
 * So: prune for rendering, merge for storage. Nothing that shrinks a view is allowed to
 * shrink what is stored.
 */

export type PositionMap = Record<string, { x: number; y: number }>;

/**
 * The subset of `stored` that the current payload can actually draw.
 *
 * Read-only by contract — callers must never write the result back. Whatever is missing here
 * is missing because this view is narrower than the network, not because it is stale.
 */
export function prunePositionsForRender(
  stored: PositionMap,
  payloadIds: Iterable<string>
): PositionMap {
  const ids = payloadIds instanceof Set ? payloadIds : new Set(payloadIds);
  const pruned: PositionMap = {};
  for (const [id, pos] of Object.entries(stored)) {
    if (ids.has(id)) pruned[id] = pos;
  }
  return pruned;
}

/**
 * What to persist after a drag: everything already saved, updated by what this view moved.
 *
 * `active` is the render map, so it only ever mentions visible contacts. Writing it directly
 * would drop every position belonging to a contact outside the current view — which is the
 * whole reason this function exists rather than a bare `savePositions(next)`.
 */
export function mergePositionsForStorage(
  stored: PositionMap,
  active: PositionMap
): PositionMap {
  return { ...stored, ...active };
}
