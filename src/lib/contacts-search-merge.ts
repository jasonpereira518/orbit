/**
 * Folding a search's background enrichment into the list already on screen. Pure and
 * DOM-free, so `scripts/smoke-contacts-search-enrichment.ts` can hold it to the one-shot
 * result without a browser. Client-safe: types only from `contacts-page`.
 *
 * The enrichment carries the FINAL first page (`order`). Applying it replaces the list with
 * that page, with one exception that exists so nothing moves under a hand: the first
 * `frozen` rows of what is on screen (through the row being hovered or focused) keep their
 * places, and the rest follow in final order. `frozen = 0` is the exact one-shot result.
 */
import type { ContactsSearchEnrichment } from "@/lib/contacts-page";

export function mergeSearchEnrichment<T extends { id: string; matchReason?: string | null }>(
  current: readonly T[],
  enrichment: Pick<ContactsSearchEnrichment, "order" | "rows" | "matchReasons">,
  frozen = 0
): T[] {
  const byId = new Map<string, T>(current.map((c) => [c.id, c]));
  for (const row of enrichment.rows as unknown as T[]) if (!byId.has(row.id)) byId.set(row.id, row);

  const withReason = (c: T): T => {
    const reason = enrichment.matchReasons[c.id] ?? null;
    return (c.matchReason ?? null) === reason ? c : { ...c, matchReason: reason };
  };

  // Nothing widened the page and nothing moved: keep the list, only labels may arrive.
  if (!enrichment.order) return current.map(withReason);

  const keep = current.slice(0, Math.max(0, frozen));
  const seen = new Set(keep.map((c) => c.id));
  const out = keep.map(withReason);
  for (const id of enrichment.order) {
    if (seen.has(id)) continue;
    const row = byId.get(id);
    // An id the server ranked but we hold no row for (it is not in `have` and not in `rows`)
    // cannot be drawn; skipping it keeps the list consistent rather than throwing.
    if (!row) continue;
    seen.add(id);
    out.push(withReason(row));
  }
  return out;
}
