"use client";

import { useEffect, useRef } from "react";
import { radarKeyFor, type RadarKeyCommand } from "@/lib/radar/focus-keys";

/** Something else owns the keyboard: an open dialog, sheet, menu or listbox. */
function overlayOpen() {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
  );
  for (const el of candidates) {
    const shown = typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
    if (shown) return true;
  }
  return false;
}

/**
 * Focus mode's shortcuts. The decision is `radarKeyFor`; this wires it to the window while
 * `enabled`, reading the handler from a ref so the listener is attached once.
 */
export function useRadarKeys(enabled: boolean, onCommand: (command: RadarKeyCommand) => void) {
  const handler = useRef(onCommand);
  useEffect(() => {
    handler.current = onCommand;
  });

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const command = radarKeyFor({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        targetTag: target ? target.tagName.toLowerCase() : null,
        targetEditable: Boolean(target?.isContentEditable),
        overlayOpen: overlayOpen(),
      });
      if (!command) return;
      e.preventDefault();
      handler.current(command);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
