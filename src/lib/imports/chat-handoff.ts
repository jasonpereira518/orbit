/**
 * Chat exports dropped anywhere on /imports, waiting for the Chat messages card.
 *
 * The hub classifies a drop but the card owns reading, parsing and previewing chats, and the
 * card's panel is only mounted while its row is open. A module-scope bus lets the hub hand
 * files over before the card exists: the card consumes them on mount (or as soon as it is
 * idle) and clears the slot. Read it with `useSyncExternalStore` — a plain module read would
 * go stale for a card that is already mounted.
 */
import { useSyncExternalStore } from "react";

const NONE: File[] = [];
let pending: File[] = NONE;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Queue files for the card. A second drop before the first is consumed adds to it. */
export function handOffChatFiles(files: File[]): void {
  if (!files.length) return;
  pending = [...pending, ...files];
  emit();
}

export function clearChatHandoff(): void {
  if (pending === NONE) return;
  pending = NONE;
  emit();
}

/** The current snapshot; stable between changes, as `useSyncExternalStore` requires. */
export function getChatHandoff(): File[] {
  return pending;
}

export function useChatHandoff(): File[] {
  return useSyncExternalStore(subscribe, getChatHandoff, () => NONE);
}
