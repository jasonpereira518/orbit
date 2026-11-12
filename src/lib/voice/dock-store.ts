"use client";
import { useSyncExternalStore } from "react";
import type { VoicePublicState } from "./contracts";

/**
 * The one live Orbit Voice call, held above the page so it survives navigation.
 * `VoiceDock` (app layout) renders it; the chat page only offers a `slot` to dock it inline.
 */
export type VoiceDockState = {
  call: { threadId: string; state: VoicePublicState } | null;
  slot: HTMLElement | null;
};

let current: VoiceDockState = { call: null, slot: null };
const listeners = new Set<() => void>();
const endListeners = new Set<(threadId: string) => void>();

function set(next: Partial<VoiceDockState>) {
  current = { ...current, ...next };
  for (const fn of listeners) fn();
}

export function openVoice(threadId: string, state: VoicePublicState) {
  if (!current.call) set({ call: { threadId, state } });
}

/** Admin changes (provider, fallback) reach a live call through Chat's status poll. */
export function updateVoiceState(state: VoicePublicState) {
  if (current.call) set({ call: { ...current.call, state } });
}

export function closeVoice() {
  const threadId = current.call?.threadId;
  set({ call: null });
  if (threadId) for (const fn of endListeners) fn(threadId);
}

export function setVoiceSlot(el: HTMLElement | null) {
  if (current.slot !== el) set({ slot: el });
}

export function onVoiceEnded(fn: (threadId: string) => void) {
  endListeners.add(fn);
  return () => void endListeners.delete(fn);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const SERVER: VoiceDockState = { call: null, slot: null };
export function useVoiceDock(): VoiceDockState {
  return useSyncExternalStore(subscribe, () => current, () => SERVER);
}
