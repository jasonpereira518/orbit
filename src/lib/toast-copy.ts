/**
 * Toast wording that appears in more than one place, so the same outcome reads the same
 * way everywhere.
 *
 * Before this, one save failure was worded four ways across the app — "Save failed",
 * "Failed to save", "Could not save", "Couldn't save that." — and "Import failed" and
 * "OAuth failed" were each repeated by hand in five or six files. A phrase lives here
 * once it is used by more than one file; one-off wording stays at its call site.
 *
 * The voice, from the friendlier-toasts spec
 * (docs/superpowers/specs/2026-09-10-friendlier-toasts-design.md):
 *
 * - Say what happened, then what to do.
 * - Blame the system, never the person.
 * - "Couldn't" — never "Could not" or "Failed to".
 * - Curly apostrophes; " — " as the one connector; no trailing period on a single clause.
 * - Orbit's own vocabulary on success only, never on an error.
 *
 * `scripts/check-toast-copy.ts` enforces the mechanical rules across every call site.
 *
 * Deliberately free of imports: it is pulled into client components.
 */
export const TOAST_COPY = {
  saveFailed: "That didn’t save — try again?",
  sendFailed: "That didn’t send — try again?",
  deleteFailed: "Couldn’t delete that — try again?",
  undoFailed: "Couldn’t undo that — try again?",
  mergeFailed: "Couldn’t merge those — try again?",
  importFailed: "That import didn’t finish — try again?",
  previewFailed: "Couldn’t preview that file — check it and try again",
  connectFailed: "Couldn’t connect your account — try again?",
  loadContactsFailed: "Couldn’t load your contacts — try again?",
  draftFollowUpFailed: "Couldn’t draft that follow-up — try again?",
  summaryFailed: "Couldn’t write a summary — try again?",
  copyFailed: "Couldn’t copy — select it and copy by hand",
  copied: "Copied",
  chatFailed: "Couldn’t get an answer — try again?",
  chatStartFailed: "Couldn’t start a chat — try again?",
  notesReadFailed: "Couldn’t read those notes — try again?",
  fileReadFailed: "Couldn’t read that file — try a different one?",
  reminderSet: "Reminder set",
} as const;
