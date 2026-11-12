"use client";
import { useSyncExternalStore } from "react";
import { createExternalStore } from "@/lib/create-external-store";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import type { VoiceProvider } from "./config";
import type { VoiceAgentControls, VoiceMode } from "./contracts";

/**
 * The live call as views see it. `VoiceEngine` (mounted once by `VoiceDock`, never portalled)
 * owns the call and writes here; any number of views read it, so moving or remounting a view
 * can never hang up.
 */
export type TranscriptTurn = { id: string; source: "user" | "ai"; text: string; interrupted: boolean; revision: number };
export type VoiceCard = { messageId: string; action: StoredProposedAction };
export type VoiceCallView = {
  provider: VoiceProvider;
  /** A provider session is open (credentials minted). */
  active: boolean;
  mode: VoiceMode;
  busy: boolean;
  muted: boolean;
  error: string;
  /** The last failure was the provider's, so a fallback is worth offering. */
  failed: boolean;
  lines: TranscriptTurn[];
  cards: VoiceCard[];
  saveError: boolean;
  closing: boolean;
};
export type VoiceCallActions = {
  start(fallback?: boolean): void;
  close(): Promise<void>;
  toggleMute(): void;
  retrySaves(): Promise<void>;
  settleCard(next: StoredProposedAction): void;
};

const IDLE: VoiceCallView = {
  provider: "deepgram",
  active: false,
  mode: "disconnected",
  busy: false,
  muted: false,
  error: "",
  failed: false,
  lines: [],
  cards: [],
  saveError: false,
  closing: false,
};
let view = IDLE;
const store = createExternalStore({ getSnapshot: () => view, getServerSnapshot: () => IDLE });

export function getVoiceCall(): VoiceCallView {
  return view;
}
export function setVoiceCall(patch: Partial<VoiceCallView>) {
  view = { ...view, ...patch };
  store.emit();
}
export function resetVoiceCall(provider: VoiceProvider = IDLE.provider) {
  view = { ...IDLE, provider };
  store.emit();
}
export function useVoiceCall(): VoiceCallView {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** The live provider controls; `VoiceOrbit` reads levels from here every frame. */
export const voiceControls: { current: VoiceAgentControls | null } = { current: null };

const NOOP: VoiceCallActions = {
  start: () => {},
  close: async () => {},
  toggleMute: () => {},
  retrySaves: async () => {},
  settleCard: () => {},
};
let installed: VoiceCallActions = NOOP;
/** The engine installs its actions while mounted; with no engine they do nothing. */
export function installVoiceActions(actions: VoiceCallActions | null) {
  installed = actions ?? NOOP;
}
export const voiceActions: VoiceCallActions = {
  start: (fallback) => installed.start(fallback),
  close: () => installed.close(),
  toggleMute: () => installed.toggleMute(),
  retrySaves: () => installed.retrySaves(),
  settleCard: (next) => installed.settleCard(next),
};
