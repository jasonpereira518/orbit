/**
 * What a paged list shows when the server re-sends its first page.
 *
 * Both paged lists (contacts, reminders) re-sync from the server's first page during render.
 * That page is re-sent far more often than the list changes: after every mutation's
 * re-render, on `useRefreshOnVisible` (every return to the tab), on `FreshOnArrival`. Each
 * one used to throw away every page loaded since, so someone forty pages down was put back
 * at page one for alt-tabbing away.
 *
 * Now, for the SAME list (same filters): the fresh first page, then the rows already loaded
 * after the old first page that the fresh page does not already hold. A row the fresh page
 * dropped (deleted, completed, or moved out of the filter) is gone, because it was on the
 * first page; the tail stays as it was loaded until the next full load. A different list (a
 * filter change) starts over, as before.
 *
 * Pure, no imports: it runs during render in client components.
 */
export function mergeRefreshedFirstPage<T extends { id: string }>(
  loaded: readonly T[],
  oldFirstPageLength: number,
  freshFirstPage: readonly T[]
): T[] {
  if (loaded.length <= oldFirstPageLength) return [...freshFirstPage];
  const fresh = new Set(freshFirstPage.map((row) => row.id));
  return [...freshFirstPage, ...loaded.slice(oldFirstPageLength).filter((row) => !fresh.has(row.id))];
}
