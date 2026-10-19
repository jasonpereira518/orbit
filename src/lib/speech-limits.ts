/**
 * What a plan may spend on Deepgram, in audio seconds.
 *
 * Seconds rather than requests, because Deepgram bills per second and the promise to the
 * user is hours. Two meters, not one: a meeting can run three hours and would otherwise eat
 * a shared pool that voice notes and the chat mic depend on.
 *
 * Client-safe: no DB, no env, no server imports.
 */
import { MAX_MEETING_MS } from "@/lib/meeting-chunking";
import { PLAN_CONFIG, PLANS, type Plan } from "@/lib/plans/plan-config";

export type SpeechKind = "meeting" | "shortform";

/** Warn once the month is this far gone. */
const WARN_AT = 0.9;

/**
 * Seconds per month, per meter and plan — read from the single plan table.
 * Meetings: Free none, Pro 8 h, Max and Lifetime 15 h. Voice notes and the chat mic
 * (short-form): Free 90 min, Pro 8 h, Max and Lifetime 15 h. Raised 1.5x in Oct 2026, funded
 * by the Deepgram credit (`speech-cost.ts`).
 */
export const SPEECH_LIMITS: Record<SpeechKind, Record<Plan, number>> = {
  meeting: Object.fromEntries(
    PLANS.map((plan) => [plan, PLAN_CONFIG[plan].speech.meetingSeconds])
  ) as Record<Plan, number>,
  shortform: Object.fromEntries(
    PLANS.map((plan) => [plan, PLAN_CONFIG[plan].speech.shortformSeconds])
  ) as Record<Plan, number>,
};

export function limitFor(kind: SpeechKind, plan: Plan): number {
  return SPEECH_LIMITS[kind][plan];
}

/**
 * LENIENT BY DESIGN: a meeting that has started is never cut off by the monthly meter. The cap
 * decides whether a NEW meeting may start; once one is recording on Deepgram, it runs to its own
 * length limit (`MAX_MEETING_MS`, three hours) even if the month's hours run out partway. The
 * overrun lands on the meter like any other seconds, so the next meeting is the one refused.
 * What bounds the total is the Deepgram credit's ladder (`speech-cost.ts`), not this.
 *
 * Returns the seconds a live token should let this meeting stream before the browser stops it.
 */
export function meetingSecondsAllowed(input: {
  remaining: number;
  inProgress: boolean;
  /** How far into the meeting we already are. */
  elapsedMs: number;
}): number {
  if (!input.inProgress) return input.remaining;
  const rest = Math.max(0, Math.floor((MAX_MEETING_MS - input.elapsedMs) / 1000));
  return Math.max(input.remaining, rest);
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
