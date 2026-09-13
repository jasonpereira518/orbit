"use client";

import { useEffect, useRef } from "react";

/**
 * Focus for the settings panels' two-step destructive confirms (revoke a key, remove a
 * webhook, replace the calendar link).
 *
 * Pressing the trash icon swaps it for "Revoke / Cancel" in place. Without this, focus stays
 * on a button that no longer exists: a keyboard user is dropped back at the top of the
 * document and a screen reader announces nothing, so the confirm they asked for is
 * effectively invisible to them. Focus moves to the confirm button when it appears, and back
 * to the trigger when the confirm is cancelled.
 *
 * `confirming` is the key of the row being confirmed (a list's item id, or any fixed string
 * for a single confirm), or null when none is.
 */
export function useConfirmFocus(confirming: string | null) {
  const confirmEls = useRef(new Map<string, HTMLElement>());
  const triggerEls = useRef(new Map<string, HTMLElement>());
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (confirming !== null) {
      confirmEls.current.get(confirming)?.focus();
    } else if (previous.current !== null) {
      // Absent when the confirm went through and its row is gone — nothing to return to.
      triggerEls.current.get(previous.current)?.focus();
    }
    previous.current = confirming;
  }, [confirming]);

  // The map is read inside the callback, not here, so nothing touches a ref during render.
  const register =
    (map: React.RefObject<Map<string, HTMLElement>>, key: string) =>
    (el: HTMLElement | null) => {
      if (el) map.current.set(key, el);
      else map.current.delete(key);
    };

  return {
    confirmRef: (key: string) => register(confirmEls, key),
    triggerRef: (key: string) => register(triggerEls, key),
  };
}
