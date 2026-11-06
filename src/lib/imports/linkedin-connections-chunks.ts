/**
 * The shapes and chunk sizes the chunked connections import's two halves agree on (see
 * `linkedin-connections-staging.ts`). Import-free, so the browser half can use it without
 * pulling in the server half.
 */

/** Rows per duplicate check: ~0.6 MB up at LinkedIn's field lengths. */
export const CONNECTIONS_MATCH_MAX_ROWS = 5_000;
/** Rows per staged upload: ~0.5 MB up. */
export const CONNECTIONS_APPEND_MAX_ROWS = 2_000;

/** What a duplicate check is asked about one row. */
export type ConnectionMatchRow = {
  index: number;
  fullName: string;
  email: string;
  url: string;
  company: string;
  position: string;
};

/** A row that looks like someone already in the network. Rows with no candidate are not answered. */
export type ConnectionMatch = {
  index: number;
  isRepeat: boolean;
  duplicate: { id: string; fullName: string; reason: string; confidence: number };
};

/** One staged row: the export's columns and the row's position in the file. */
export type StagedConnectionRow = {
  index: number;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
  url: string;
};
