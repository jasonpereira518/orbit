"use client";

import { useSyncExternalStore } from "react";

/**
 * Toasts that outlive their four seconds.
 *
 * A toast is the only place most of this app reports a failure, and it is gone
 * whether or not anyone was looking at the screen. Two kinds are worth keeping:
 * something that failed, and something that offered an action you did not take
 * in time. Everything else — the ~136 plain "Saved" confirmations — is noise the
 * moment it has been read once, and keeping it would bury the two that matter.
 *
 * Mirrored to localStorage so a failure you missed is still there after a
 * reload. Per-device by design: this never syncs, and is not a substitute for
 * anything the server records.
 *
 * Shape deliberately mirrors `background-jobs.ts` — module Map + listener set +
 * `useSyncExternalStore` — because the notifications panel already renders that
 * store alongside its server data, and a second pattern there would be a third
 * thing to reason about.
 */

export type KeptNotificationTone = "error" | "action";

export type KeptNotification = {
  id: string;
  tone: KeptNotificationTone;
  title: string;
  description?: string;
  /** Epoch ms the toast left the screen. */
  at: number;
  read?: boolean;
  /** Label of the toast's action button, when it had one. */
  actionLabel?: string;
};

const STORAGE_KEY = "orbit:kept-notifications:v1";
/** Beyond this the panel is a log, not a to-do list. Oldest are evicted first. */
const MAX_ENTRIES = 30;
/** A week-old failure is history; the app has moved on and so has the user. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const entries = new Map<string, KeptNotification>();
const listeners = new Set<() => void>();

/**
 * Action callbacks, held separately because they are closures and cannot be
 * serialized. An entry restored from localStorage therefore has its label but
 * no button — the item still says what happened, which is the point, and an
 * Undo offered hours after a reload would be a surprise rather than a courtesy.
 */
const liveActions = new Map<string, () => void>();

let cachedList: KeptNotification[] = [];
let hydrated = false;

const EMPTY: KeptNotification[] = [];

function recompute() {
  cachedList = Array.from(entries.values()).sort((a, b) => b.at - a.at);
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedList));
  } catch {
    // Private mode, quota, or site data blocked. The in-memory store still
    // works for this session; losing the mirror is not worth breaking a toast.
  }
}

function emit() {
  recompute();
  persist();
  for (const listener of listeners) listener();
}

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, entry] of entries) {
    if (entry.at < cutoff) {
      entries.delete(id);
      liveActions.delete(id);
    }
  }
  if (entries.size > MAX_ENTRIES) {
    // Map preserves insertion order, but entries can be restored out of order,
    // so evict by age rather than by position.
    const byNewest = Array.from(entries.values()).sort((a, b) => b.at - a.at);
    for (const entry of byNewest.slice(MAX_ENTRIES)) {
      entries.delete(entry.id);
      liveActions.delete(entry.id);
    }
  }
}

/**
 * Read the mirror once, on the first client subscription rather than at module
 * scope: touching localStorage during render would make the server and client
 * snapshots disagree and trip hydration.
 */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as KeptNotification).id === "string" &&
        typeof (item as KeptNotification).title === "string" &&
        typeof (item as KeptNotification).at === "number"
      ) {
        const entry = item as KeptNotification;
        entries.set(entry.id, entry);
      }
    }
    prune();
    recompute();
  } catch {
    // Corrupt or unreadable mirror: start empty rather than throw on boot.
  }
}

/** Record a toast that has just left the screen. Idempotent per id. */
export function keepNotification(
  entry: Omit<KeptNotification, "at" | "read"> & {
    at?: number;
    onAction?: () => void;
  }
) {
  hydrate();
  if (entries.has(entry.id)) return;
  const { onAction, ...rest } = entry;
  entries.set(entry.id, { ...rest, at: entry.at ?? Date.now(), read: false });
  if (onAction) liveActions.set(entry.id, onAction);
  prune();
  emit();
}

export function dismissKeptNotification(id: string) {
  if (!entries.delete(id)) return;
  liveActions.delete(id);
  emit();
}

export function clearKeptNotifications() {
  if (entries.size === 0) return;
  entries.clear();
  liveActions.clear();
  emit();
}

/** Called when the panel opens: the badge is about unseen items, not unread ones. */
export function markKeptNotificationsRead() {
  let changed = false;
  for (const [id, entry] of entries) {
    if (!entry.read) {
      entries.set(id, { ...entry, read: true });
      changed = true;
    }
  }
  if (changed) emit();
}

/** Whether this entry's action still works — false once restored from storage. */
export function hasLiveAction(id: string) {
  return liveActions.has(id);
}

export function runKeptAction(id: string) {
  liveActions.get(id)?.();
}

function subscribe(listener: () => void) {
  hydrate();
  listeners.add(listener);
  // A second tab writing the mirror should not silently diverge from this one.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    hydrated = false;
    entries.clear();
    hydrate();
    for (const l of listeners) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot() {
  return cachedList;
}

function getServerSnapshot() {
  return EMPTY;
}

export function useKeptNotifications() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useUnreadKeptCount() {
  return useKeptNotifications().filter((entry) => !entry.read).length;
}
