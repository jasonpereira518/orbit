/**
 * Every line the import surfaces can show a person.
 *
 * Separate from `TOAST_COPY` because `scripts/smoke-toast-copy.ts` reads that file by name and
 * by block, and because most of these are not toasts at all — they are row chips, empty
 * states, and the plain-language half of a failure. `scripts/smoke-import-errors.ts` holds
 * this file to the same house voice: curly apostrophes, "Couldn’t" never "Could not", never
 * the word "failed" (say what didn’t happen), no trailing period, " — " as the one connector.
 *
 * Flat string literals on purpose: the guard reads them out of the source text the same way it
 * reads `TOAST_COPY`, so anything computed here would be invisible to it.
 */
export const IMPORT_COPY = {
  previewFailed: "Couldn’t read that file — check it and try again",
  importFailed: "That import didn’t finish — try again?",
  nothingRecognised:
    "Nothing in that drop looked like contacts, messages or a calendar — the Connections.csv from your LinkedIn export is a good place to start",
  dropHint: "Drop to import",
  dropTitle: "Drop anything here",
  dropBody:
    "A LinkedIn export (the whole ZIP is fine), a contacts file, a calendar — or a whole folder. Orbit works out what each file is",
  notImported: "Not imported",
  truncated:
    "That folder had more files than Orbit reads in one go — drop the rest after this",
  stopped: "Import stopped",
  driveUnavailable: "Couldn’t open Google Drive — try again in a moment",
  drivePaywalled: "Google Drive is on paid plans",
  driveWaitForQueue: "Finish or clear the files above first",
} as const;

export type ImportCopyKey = keyof typeof IMPORT_COPY;
