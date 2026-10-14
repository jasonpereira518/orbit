"use client";

import { useSyncExternalStore } from "react";

/**
 * "Not now" for one thing, on this device: ids kept in localStorage (the last 50), plus an
 * in-memory set for a tab whose storage is blocked. `useVersion` re-renders a reader when any
 * id is dismissed, so a card disappears the moment its button is pressed.
 */
export function createDismissStore(storageKey: string) {
  const inSession = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;

  const read = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
    } catch {
      return [];
    }
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  };

  return {
    isDismissed(id: string): boolean {
      return inSession.has(id) || read().includes(id);
    },
    dismiss(id: string): void {
      inSession.add(id);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...read(), id].slice(-50)));
      } catch {
        // Storage blocked: the in-session set covers this tab.
      }
      version++;
      listeners.forEach((l) => l());
    },
    useVersion(): number {
      return useSyncExternalStore(subscribe, () => version, () => 0);
    },
  };
}
