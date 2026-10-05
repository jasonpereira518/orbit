/**
 * Invites out: how many times this visitor has COMPLETED a share of their link (the native
 * share sheet reported success) that has not turned into a friend joining yet. The referral
 * tracker draws them as "invited" circles after the filled ones.
 *
 * Only completed shares count — a copied link may never be sent, and the page cannot know.
 * Each friend who joins consumes one invite, since a join is what an invite was waiting for;
 * the count can never exceed the tracker's empty circles.
 *
 * Device-local, like `pass-seen.ts`: one record for the last pass shared from here, every
 * storage access guarded. A module store read with `useSyncExternalStore`, the same shape as
 * `interest-progress-store.ts`; the server snapshot is 0.
 */
import { useSyncExternalStore } from "react";
import { TRACKER_SLOTS } from "./interest-list";

const KEY = "waitlist-pass-invites";

export type InviteRecord = { token: string; pending: number; referrals: number };

/**
 * The record after `event`, from `before` (null: nothing stored for this pass).
 * `share` adds one invite at the pass's current referral count; `sync` brings the record up
 * to a referral count, consuming one invite per friend who joined since it was written.
 */
export function nextInvites(
  before: InviteRecord | null,
  token: string,
  referrals: number,
  event: "share" | "sync"
): InviteRecord {
  const base = before && before.token === token ? before : { token, pending: 0, referrals };
  const joined = Math.max(0, referrals - base.referrals);
  let pending = Math.max(0, base.pending - joined);
  if (event === "share") pending += 1;
  pending = Math.min(pending, Math.max(0, TRACKER_SLOTS - referrals));
  return { token, pending, referrals: Math.max(referrals, base.referrals) };
}

function local(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function readInvites(storage?: Storage): InviteRecord | null {
  try {
    const raw = (storage ?? local())?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<InviteRecord>;
    if (
      typeof v.token !== "string" ||
      !Number.isInteger(v.pending) ||
      !Number.isInteger(v.referrals) ||
      (v.pending as number) < 0 ||
      (v.referrals as number) < 0
    ) {
      return null;
    }
    return { token: v.token, pending: v.pending as number, referrals: v.referrals as number };
  } catch {
    return null;
  }
}

function writeInvites(record: InviteRecord, storage?: Storage) {
  try {
    (storage ?? local())?.setItem(KEY, JSON.stringify(record));
  } catch {
    // Blocked or full: the invited circles just last as long as the page.
  }
}

/* ── The live store ── */

let current: InviteRecord | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (!loaded) {
    loaded = true;
    current = readInvites();
  }
  return current;
}

function apply(token: string, referrals: number, event: "share" | "sync") {
  const next = nextInvites(load(), token, referrals, event);
  const prev = current;
  if (prev && prev.token === next.token && prev.pending === next.pending && prev.referrals === next.referrals) {
    return;
  }
  current = next;
  writeInvites(next);
  for (const l of listeners) l();
}

/** A share of `token`'s link completed while the pass stood at `referrals`. */
export function recordShare(token: string, referrals: number) {
  apply(token, referrals, "share");
}

/** The pass now stands at `referrals`: friends who joined consume invites. */
export function syncInvites(token: string, referrals: number) {
  apply(token, referrals, "sync");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Invites out for `token`, 0 on the server, before hydration, and for any other pass. */
export function usePendingInvites(token: string | null): number {
  return useSyncExternalStore(
    subscribe,
    () => {
      const r = load();
      return token && r?.token === token ? r.pending : 0;
    },
    () => 0
  );
}
