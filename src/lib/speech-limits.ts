/**
 * What a plan may spend on Deepgram, in audio seconds.
 *
 * Seconds rather than requests, because Deepgram bills per second and the promise to the
 * user is hours. Two meters, not one: a meeting can run three hours and would otherwise eat
 * a shared pool that voice notes and the chat mic depend on.
 *
 * Client-safe: no DB, no env, no server imports.
 */
import type { Plan } from "@/lib/plan-limits";

export type SpeechKind = "meeting" | "shortform";

/** Warn once the month is this far gone. */
const WARN_AT = 0.9;

export const SPEECH_LIMITS: Record<SpeechKind, Record<Plan, number>> = {
  // Meetings are a paid feature: 5 h on Pro, 10 h on Lifetime.
  meeting: { free: 0, orbit: 18_000, lifetime: 36_000 },
  // Voice notes and the chat mic. Generous on purpose — this is an abuse ceiling, not a meter
  // anyone should watch.
  shortform: { free: 3_600, orbit: 18_000, lifetime: 18_000 },
};

export function limitFor(kind: SpeechKind, plan: Plan): number {
  return SPEECH_LIMITS[kind][plan];
}

/**
 * Which meter a transcription call spends from, decided by WHAT is being transcribed rather
 * than by which call site asked.
 *
 * This is the rule that keeps meeting audio off the voice-note meter. Meeting chunk recovery
 * — the fallback that carries the meeting whenever the live socket cannot open, e.g. behind a
 * firewall that blocks `wss://` — goes through the same file-transcription function a voice
 * note does. Metered by call site, three hours of recovered meeting would spend Orbit's key
 * while the `meeting` cap read zero and the user's short-form allowance quietly drained until
 * voice notes stopped working. Metered by operation, it spends the meter it belongs to.
 */
export function speechKindForOperation(operation: string): SpeechKind {
  return operation.startsWith("meeting.") ? "meeting" : "shortform";
}

export function quotaState(used: number, limit: number) {
  const remaining = Math.max(0, limit - used);
  const fraction = limit <= 0 ? 1 : Math.min(1, used / limit);
  return { remaining, fraction, warn: fraction >= WARN_AT && limit > 0, exhausted: remaining <= 0 };
}

/** The calendar month in UTC, matching how the managed-AI allowance already counts. */
export function monthWindow(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, resetsAt };
}
