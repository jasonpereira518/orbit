/**
 * Per-row reasons a Drive import stores on `import_job_rows.error_message`.
 *
 * Orbit's own sentences, already in the house voice — so the detail sheet shows them as they
 * are instead of running them through the failure classifier (which reads anything it doesn't
 * recognise as "This import didn’t finish"). Import-free so both the processor and the
 * client-safe `import-errors.ts` can read it.
 */
export const DRIVE_ROW_COPY = {
  unavailable: "Orbit can’t open this file any more — it may have been deleted or unshared",
  notAuthorized: "Orbit isn’t allowed to open this file — pick it again from Google Drive",
  tooLarge: "This file is too long to read as notes",
  tookTooLong: "This one took too long to read",
  empty: "Nothing written in this one",
  nobody: "No people or dates in this one",
  alreadyImported: "Already brought in, and unchanged since then",
  unreadable: "Orbit couldn’t read this one",
  busy: "Google Drive was too busy for this one — import it again later",
} as const;

const OWN_ROW_COPY: ReadonlySet<string> = new Set(Object.values(DRIVE_ROW_COPY));

/** True when a stored row reason is one of Orbit's own sentences above. */
export function isDriveRowCopy(message: string | null | undefined): boolean {
  return Boolean(message) && OWN_ROW_COPY.has(message!.trim());
}
