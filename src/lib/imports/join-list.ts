/**
 * "A", "A and B", "A, B and C".
 *
 * One helper for every import sentence that names several things — the finish's sources line,
 * the unfinished-steps line and the queue's summary toast. Three hand-written versions of this
 * had already drifted: one of them read "From a.csv and b.csv and c.csv".
 */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
