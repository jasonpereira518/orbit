"use client";

import type { VoiceRecording } from "@/lib/use-voice-recorder";

/**
 * A voice note recorded somewhere other than the capture page, waiting to be transcribed
 * there.
 *
 * The phone nav's Capture button records on a long press and then navigates to the Voice
 * tab. The recording is finished before that page exists — `CaptureForm` is a `dynamic()`
 * chunk — so an event would dispatch into nothing. A pending value just waits for the
 * panel to subscribe, the same reasoning as `src/lib/feedback-events.ts`.
 *
 * In memory only. A six-minute WAV is ~15 MB as base64, well past what sessionStorage
 * will hold, and a note that does not survive a reload is an acceptable loss for a
 * hand-off that spans one client navigation.
 */

let pending: VoiceRecording | null = null;
const listeners = new Set<() => void>();

export function handOffVoiceRecording(recording: VoiceRecording) {
  pending = recording;
  for (const listener of listeners) listener();
}

/**
 * Capture panel only. Reads and clears in one go, so a recording is transcribed exactly
 * once however many times the subscriber re-runs.
 */
export function takePendingVoiceRecording(): VoiceRecording | null {
  const next = pending;
  pending = null;
  return next;
}

/** Capture panel only. Notified when a recording is handed off; read it with `take…`. */
export function subscribePendingVoiceRecording(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
