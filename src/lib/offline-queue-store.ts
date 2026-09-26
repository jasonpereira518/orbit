"use client";

import { useSyncExternalStore } from "react";
import { isNetworkError } from "@/lib/errors";
import {
  enqueueOfflineAction,
  offlineQueueKey,
  readOfflineQueue,
  removeQueuedAction,
  writeOfflineQueue,
  type OfflineActionKind,
  type OfflineIntent,
  type QueuedAction,
} from "@/lib/offline-queue";

/**
 * The browser half of the offline queue: which account's queue is live, who is watching it,
 * and the replay.
 *
 * This file deliberately imports no Server Actions — `runToastAction` in `toast.tsx` queues
 * through it, and `toast.tsx` is loaded on every page. The runners are handed in by
 * `OfflineSync` (mounted once in the app shell) through `configureOfflineQueue`.
 */

export type OfflineRunners = {
  [K in OfflineActionKind]: (intent: Extract<OfflineIntent, { kind: K }>) => Promise<unknown>;
};

export type FlushResult = { sent: number; dropped: number; stalled: boolean };

const EMPTY: readonly QueuedAction[] = [];

let userKey: string | null = null;
let runners: OfflineRunners | null = null;
let queue: readonly QueuedAction[] = EMPTY;
let flushing: Promise<FlushResult> | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function emit() {
  for (const l of listeners) l();
}

function setQueue(next: readonly QueuedAction[]) {
  queue = next.length ? next : EMPTY;
  const s = storage();
  if (s && userKey) writeOfflineQueue(s, userKey, queue);
  emit();
}

function reload() {
  const s = storage();
  const next = s && userKey ? readOfflineQueue(s, userKey) : [];
  queue = next.length ? next : EMPTY;
  emit();
}

function onStorage(event: StorageEvent) {
  // Another tab queued or sent something: show the same count here.
  if (event.key === userKey) reload();
}

/**
 * Point the queue at an account and give it the functions that send each kind. Returns the
 * teardown. Called by `OfflineSync`; nothing is queued or sent before it runs.
 */
export function configureOfflineQueue(userId: string, next: OfflineRunners): () => void {
  userKey = offlineQueueKey(userId);
  runners = next;
  reload();
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    userKey = null;
    runners = null;
    queue = EMPTY;
    emit();
  };
}

/** Whether a change can be queued right now — false before `OfflineSync` has mounted. */
export function canQueueOffline(): boolean {
  return userKey !== null && runners !== null;
}

export function queueOfflineAction(intent: OfflineIntent) {
  if (!canQueueOffline()) return false;
  setQueue(enqueueOfflineAction(queue, intent));
  return true;
}

/**
 * Hold the queue for the whole replay, across tabs. Two tabs that both see the connection
 * come back must not both send the same change — safe-to-replay limits the damage, but it
 * would still announce "synced" twice. The Web Locks API is in every current browser; where
 * it is missing, the replay runs unlocked, which is the pre-lock behaviour.
 */
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  // The lock resolves with the callback's own promise, flattened; lib.dom types it nested.
  return locks.request(`${userKey ?? "orbit"}:flush`, fn) as unknown as Promise<T>;
}

/**
 * A failure that says nothing about the change itself, so it is worth sending again later:
 * the network, or Next's "unexpected response" — what a Server Action call throws when
 * something in front of the function (an edge error page, a 503 during a deploy) answered
 * instead of the action.
 */
function isTransientFailure(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  return (
    err instanceof Error && /unexpected response was received from the server/i.test(err.message)
  );
}

/**
 * Send everything waiting, oldest first.
 *
 * - Sent, whatever it returned: removed.
 * - Died on the network again: stop and keep it and everything behind it for the next
 *   reconnect — order matters when two changes touch related rows.
 * - Refused by the server (the reminder was deleted meanwhile, the session expired): dropped
 *   and counted, so one bad entry cannot wedge every change behind it forever.
 */
export function flushOfflineQueue(): Promise<FlushResult> {
  if (flushing) return flushing;
  const run = runners;
  if (!run || !userKey || queue.length === 0) {
    return Promise.resolve({ sent: 0, dropped: 0, stalled: false });
  }
  flushing = withQueueLock(async () => {
    // Re-read inside the lock: another tab may have just sent part of it.
    reload();
    let sent = 0;
    let dropped = 0;
    for (const item of [...queue]) {
      try {
        // The union is narrowed per kind by `OfflineRunners`; TS cannot follow the
        // correlation through an index, hence the cast.
        await (run[item.kind] as (i: QueuedAction) => Promise<unknown>)(item);
        sent += 1;
      } catch (err) {
        if (isTransientFailure(err)) return { sent, dropped, stalled: true };
        dropped += 1;
      }
      setQueue(removeQueuedAction(queue, item.id));
    }
    return { sent, dropped, stalled: false };
  }).finally(() => {
    flushing = null;
  });
  return flushing;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => queue;
const getServerSnapshot = () => EMPTY;

/** Everything waiting to be sent, oldest first. Empty on the server and before mount. */
export function useOfflineQueue(): readonly QueuedAction[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Outside React: whether a change to `subject` is waiting — for a caller deciding whether
 *  an optimistic removal should stand after `runToastAction` queued instead of sending. */
export function isQueuedOffline(subject: string): boolean {
  return queue.some((a) => a.subject === subject);
}

/** Whether a change to `subject` (a reminder id) is waiting to be sent. */
export function useIsQueuedOffline(subject: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => queue.some((a) => a.subject === subject),
    () => false
  );
}
