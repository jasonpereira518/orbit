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
  /** Orbit Voice's public state, read once per page by CosmoRoot (on load and when the tab returns). */
  state: VoicePublicState | null;
};

let current: VoiceDockState = { call: null, slot: null, state: null };
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

/** Admin changes (provider, fallback) reach a live call, and the Chat mic, through the status read. */
export function updateVoiceState(state: VoicePublicState | null) {
  set(current.call && state ? { state, call: { ...current.call, state } } : { state });
}

export function closeVoice() {
  const threadId = current.call?.threadId;
  set({ call: null });
  if (threadId) for (const fn of endListeners) fn(threadId);
}

/**
 * Cosmo's docked bar is still showing on its way into Chat's stage (CosmoRoot's short linger):
 * the orb stays in the bar until it is over, then flies. Kept apart from the dock state so the
 * orb can read it without re-rendering everything that reads the dock.
 */
let handoff = false;
const handoffListeners = new Set<() => void>();
export function setVoiceHandoff(on: boolean) {
  if (handoff === on) return;
  handoff = on;
  for (const fn of handoffListeners) fn();
}
export function useVoiceHandoff(): boolean {
  return useSyncExternalStore(
    (fn) => {
      handoffListeners.add(fn);
      return () => void handoffListeners.delete(fn);
    },
    () => handoff,
    () => false,
  );
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

const SERVER: VoiceDockState = { call: null, slot: null, state: null };
export function useVoiceDock(): VoiceDockState {
  return useSyncExternalStore(subscribe, () => current, () => SERVER);
}
