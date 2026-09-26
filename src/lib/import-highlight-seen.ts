"use client";

import { useSyncExternalStore } from "react";

/**
 * Which of an import's new people this browser has already looked at on `/contacts`.
 *
 * "Meet your N new people" opens the whole list with those N rows marked in yellow, and a mark
 * goes away once its row is hovered, focused or opened. That is a fact about this viewer, not
 * about the contact, so it lives in `localStorage` rather than the database — per-device and
 * free. Only the latest import is remembered: an older one's marks are not worth keeping, and
 * one entry cannot grow without bound.
 *
 * Every read and write is wrapped (a private window, a full quota or a blocked origin all
 * throw), and a failure means the marks simply come back next visit.
 *
 * Read through `useSyncExternalStore` so the value has one owner and the server render has an
 * honest answer: nothing seen, so every new person is marked in the server's HTML and the
 * client removes the ones it remembers.
 */
const KEY = "orbit.contacts.importSeen";
/** A generous cap on one import's remembered ids, so a runaway import cannot fill storage. */
const MAX_IDS = 2000;
const EMPTY: ReadonlySet<string> = new Set();

type Stored = { importKey: string; ids: string[] };

let current: { importKey: string; ids: Set<string> } | null = null;
const listeners = new Set<() => void>();

function read(importKey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.importKey !== importKey || !Array.isArray(parsed.ids)) return new Set();
    return new Set(parsed.ids.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Writes coalesced to one per quarter second. A pointer sweeping a freshly imported list
 * marks a row per hover, and each write serializes the whole set (up to `MAX_IDS`, ~80KB)
 * synchronously on the main thread. A write lost to a closing tab only brings a mark back.
 */
const WRITE_DELAY_MS = 250;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite() {
  if (writeTimer !== null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (current) write(current.importKey, current.ids);
  }, WRITE_DELAY_MS);
}

function write(importKey: string, ids: ReadonlySet<string>) {
  try {
    const stored: Stored = { importKey, ids: [...ids].slice(-MAX_IDS) };
    window.localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Nothing to do: the marks come back next visit.
  }
}

function snapshot(importKey: string): ReadonlySet<string> {
  if (!importKey) return EMPTY;
  // Cached per import so `getSnapshot` returns the same reference until something changes.
  if (current?.importKey !== importKey) current = { importKey, ids: read(importKey) };
  return current.ids;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Mark one of the import's new people as seen. A no-op for someone already seen. */
export function markImportPersonSeen(importKey: string, contactId: string) {
  if (!importKey) return;
  const seen = snapshot(importKey);
  if (seen.has(contactId)) return;
  const next = new Set(seen);
  next.add(contactId);
  current = { importKey, ids: next };
  scheduleWrite();
  for (const listener of listeners) listener();
}

/** The import's new people this browser has already looked at. */
export function useImportPeopleSeen(importKey: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot(importKey),
    () => EMPTY,
  );
}
