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
  // --- A LinkedIn profile link dropped or pasted onto the page ---------------------------
  linkDropHint: "Drop to add them to your contacts",
  linkNotProfile:
    "That link isn’t a LinkedIn profile — drag in a linkedin.com/in/… address",
  linkAdding: "Adding them to your contacts…",
  linkAddFailed: "Couldn’t add them — try again in a moment",
  linkNameGuessed:
    "Their name is read from the link — check it on their page",
  dropTitle: "Drop anything here",
  dropBody:
    "A LinkedIn export (the whole ZIP is fine), a contacts file, a calendar, a whole folder — or a LinkedIn profile link. Orbit works out what each one is",
  notImported: "Not imported",
  truncated:
    "That folder had more files than Orbit reads in one go — drop the rest after this",
  stopped: "Import stopped",
  driveUnavailable: "Couldn’t open Google Drive — try again in a moment",
  drivePaywalled: "Google Drive is on paid plans",
  driveWaitForQueue: "Finish or clear the files above first",

  // --- Undoing an import ---------------------------------------------------------------
  // Every line a person reads on the way back out of an import. The counts and the names are
  // built at the call site (they are numbers, and numbers cannot live in a flat table the
  // guard reads out of source), but everything that is only words lives here.
  undoAction: "Undo this import",
  undoChecking: "Working out who can still go…",
  undoRemoving: "Taking them back out…",
  undoConfirm: "Remove them",
  undoCancel: "Keep them",
  /**
   * The secondary button once removal has started. Not `undoCancel`: by then "Keep them" is a
   * lie — clicking it only hides the dialog while the people go on being taken out.
   */
  undoDismiss: "Close and let it finish",
  undoClose: "Close",
  undoFailed: "Couldn’t undo that import — try again in a moment",
  undoGone: "That import isn’t here any more",
  undoAlreadyDone: "This import has already been undone",
  undoWindowClosed: "The 7-day window for undoing this import has closed",
  undoNobodyLeft:
    "Everyone this import brought in has been touched since, so there is nobody left to take back",
  /**
   * What undo does NOT do, said before it runs rather than discovered afterwards.
   *
   * An import that matched 6 people to contacts you already had changed those contacts, and
   * nothing anywhere stores what they used to say — so those edits are permanent and the only
   * honest moment to mention it is while the person still has a Cancel button.
   */
  undoKeepsMatched:
    "People it matched to contacts you already had stay, and the details it filled in on them stay too",
  /**
   * What undo does not look at, said before it runs.
   *
   * "Touched" is tags, notes, reminders, logged interactions, merges, and ten fields the import
   * wrote (name, company, title, email, LinkedIn, location, school, phone, website, X handle).
   * Anything else a person can change — a photo, a closeness rating, how they met — is not
   * checked, because the systems that also write those (the avatar backfill, the scorer) would
   * make every imported person read "touched". So someone changed only that way still goes.
   */
  undoUnchecked:
    "A new photo, a closeness rating or how you met doesn’t count as a change, so people you’ve only changed that way still go",
  undoInexact:
    "This import ran before Orbit started tracking edits, so it can’t tell which of these you’ve changed",
  undoStillGoing:
    "That import had a lot of people in it — undo it again to take out the rest",
  /** Why one person is staying. Read as "Ada Lovelace — you’ve tagged them". */
  undoKeptTagged: "you’ve tagged them",
  undoKeptNoted: "you’ve written a note",
  undoKeptReminded: "you’ve set a reminder",
  undoKeptInteracted: "you’ve logged something with them",
  undoKeptMerged: "you’ve merged someone into them",
  undoKeptEdited: "you’ve edited their details",
} as const;

export type ImportCopyKey = keyof typeof IMPORT_COPY;
