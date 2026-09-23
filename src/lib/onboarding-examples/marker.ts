/**
 * How the guided tour's example people are told apart from everyone else. Client-safe: no
 * database imports, so the contacts list can render the "Example" chip from the same
 * constant the seeder and remover use.
 *
 * The marker lives on `contacts.source` (and, for analytics filters, on the identity and
 * interaction rows the seeder writes). Everything else an example person owns — brief,
 * action items, reminders, chunks, embeddings, tags — cascades from the contact, so removal
 * needs no ledger and no extra columns.
 */
export const TOUR_EXAMPLE_SOURCE = "tour-example";

export function isTourExampleSource(source: string | null | undefined): boolean {
  return source === TOUR_EXAMPLE_SOURCE;
}
