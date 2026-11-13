"use client";
import { useSyncExternalStore } from "react";
import type { VoicePublicState } from "./contracts";

/**
 * The one live Orbit Voice call, held above the page so it survives navigation.
 * `VoiceDock` (app layout) renders it; the chat page only offers a `slot` to dock it inline.
 *
 * `id` names the call itself and is what the engine is keyed on: a Cosmo call starts without a
 * thread (`threadId` null) and adopts the one the server picks, which must not remount it.
 */
export type VoiceCall = {
  id: string;
  threadId: string | null;
  state: VoicePublicState;
  /** Where it was started: Chat's composer (that thread) or the Cosmo orb (the day's thread). */
  origin: "chat" | "cosmo";
  /** The nudge the idle orb showed when it was clicked; the server rebuilds its opener (nudge.ts). */
  nudge?: string;
};
export type VoiceDockState = {
  call: VoiceCall | null;
  slot: HTMLElement | null;
};

let current: VoiceDockState = { call: null, slot: null };
const listeners = new Set<() => void>();
const endListeners = new Set<(threadId: string) => void>();

function set(next: Partial<VoiceDockState>) {
  current = { ...current, ...next };
  for (const fn of listeners) fn();
}

export function openVoice(
  threadId: string | null,
  state: VoicePublicState,
  origin: VoiceCall["origin"] = "chat",
  nudge?: string,
) {
  if (!current.call) set({ call: { id: crypto.randomUUID(), threadId, state, origin, nudge } });
}

/** The server answered with the call's thread (a new one, for a Cosmo call). */
export function setCallThread(threadId: string) {
  if (current.call && current.call.threadId !== threadId) set({ call: { ...current.call, threadId } });
}

/** Admin changes (provider, fallback) reach a live call through the status poll. */
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
