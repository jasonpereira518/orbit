"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { overlayOpen } from "@/lib/overlay-open";
import { triageCommandFor, type TriageCommand } from "@/lib/triage-keys";

/**
 * The reminders queue's shortcuts. The decision (which key, and when to stay out of the
 * way) is `triageCommandFor`; this only wires it to the window. The handler is read from a
 * ref so the listener is attached once, not on every render of a busy queue.
 */
export function useTriageKeys(onCommand: (command: TriageCommand, event: KeyboardEvent) => void) {
  const handler = useRef(onCommand);
  useEffect(() => {
    handler.current = onCommand;
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const command = triageCommandFor({
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
      handler.current(command, e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Whether a media query matches. Server-renders as false, so use it to choose BEHAVIOUR
 * (open a sheet or the inline pane), never to choose markup — layout stays in CSS
 * breakpoints, or the first paint would disagree with the server's.
 */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
