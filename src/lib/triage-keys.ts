/**
 * The reminders queue's single-key shortcuts — what a key means, and when a key must be
 * left alone. Pure, so `scripts/smoke-triage-keys.ts` pins it without a browser; the
 * listener is `components/reminders/use-triage-keys.ts`.
 *
 * The guard is the part the app's other key listeners never needed: they all bind to a
 * modifier (⌘K, ⌘F) or to Escape. Single letters fire while someone types, so every
 * editable target, any open dialog or menu, and every modified key is refused here.
 */

export type TriageCommand =
  | "next"
  | "prev"
  | "toggleSelect"
  | "open"
  | "close"
  | "done"
  | "snooze"
  | "move"
  | "delete"
  | "search"
  | "create"
  | "help";

const KEYMAP: Record<string, TriageCommand> = {
  j: "next",
  ArrowDown: "next",
  k: "prev",
  ArrowUp: "prev",
  x: "toggleSelect",
  Enter: "open",
  o: "open",
  Escape: "close",
  e: "done",
  s: "snooze",
  m: "move",
  "#": "delete",
  Delete: "delete",
  "/": "search",
  c: "create",
  "?": "help",
};

/** For the help popover: one line per command, in reading order. */
export const TRIAGE_SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["j", "↓"], label: "Next reminder" },
  { keys: ["k", "↑"], label: "Previous reminder" },
  { keys: ["Enter", "o"], label: "Open details" },
  { keys: ["x"], label: "Select" },
  { keys: ["e"], label: "Mark done" },
  { keys: ["s"], label: "Snooze" },
  { keys: ["m"], label: "Move to list" },
  { keys: ["#", "Delete"], label: "Delete" },
  { keys: ["/"], label: "Search" },
  { keys: ["c"], label: "New reminder" },
  { keys: ["Esc"], label: "Close details, then clear selection" },
  { keys: ["?"], label: "Show shortcuts" },
];

/** The slice of a KeyboardEvent and its target the decision needs. */
export type TriageKeyInput = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** Lower-case tag name of the event target, e.g. "input". */
  targetTag: string | null;
  targetEditable: boolean;
  /** An open dialog, sheet, menu or popover owns the keyboard. */
  overlayOpen: boolean;
};

export function triageCommandFor(input: TriageKeyInput): TriageCommand | null {
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  // Escape still belongs to an open overlay: it closes that, not the detail pane.
  if (input.overlayOpen) return null;
  const tag = input.targetTag;
  const typing =
    input.targetEditable || tag === "input" || tag === "textarea" || tag === "select";
  if (typing) return null;
  // A focused button already answers Enter; stealing it would double-fire the click.
  if (input.key === "Enter" && (tag === "button" || tag === "a")) return null;
  return KEYMAP[input.key] ?? null;
}
