"use client";

/**
 * Something else owns the keyboard: a dialog, sheet, popover or menu is open.
 *
 * Presence alone isn't openness: Base UI's Select keeps its (hidden) listbox mounted, so
 * the reminders detail pane's two Selects used to count as "open" and swallow every
 * shortcut the moment the pane appeared. Only a rendered element counts.
 *
 * Shared by the reminders triage keys and the guided tour's coach rail, which drops its
 * scrim and its arrow keys while a dialog is up.
 */
export function overlayOpen(): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
  );
  for (const el of candidates) {
    const shown =
      typeof el.checkVisibility === "function"
        ? el.checkVisibility()
        : el.getClientRects().length > 0;
    if (shown) return true;
  }
  return false;
}
