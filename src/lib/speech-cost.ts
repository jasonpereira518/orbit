/**
 * What Orbit's Deepgram spend costs, in dollars, and the one-time credit it draws on.
 *
 * `speech_usage` meters SECONDS against the per-account plan caps. Nothing turned those
 * seconds into money, so Deepgram — the largest variable cost Orbit has — read as $0 on the
 * Money screen, in runway, and in every ops alert. This module is that conversion, plus the
 * account-wide budget the per-account caps never bounded.
 *
 * Pure on purpose: no `@/db`, no `process.env`. The pricing and the degradation ladder are
 * pinned by `scripts/smoke-speech-credit.ts` without a database, and the server half lives
 * in `speech-credit.ts`.
 */
import type { Plan } from "@/lib/plans/plan-config";
import type { SpeechKind } from "@/lib/speech-limits";

/**
 * Deepgram's pay-as-you-go list prices for Nova-3 (deepgram.com/pricing, Oct 2026 — see
 * COST_AUDIT.md for the confirmation status). Per minute of audio.
 */
export const DEEPGRAM_LIST_PER_MINUTE = {
  streaming: 0.0077,
  file: 0.0043,
  /** Add-on: meeting sockets send `diarize=true`. File requests never do. */
  diarize: 0.002,
  /** Add-on: charged whenever a request carries `keyterm` (the account's contact names). */
  keyterm: 0.0013,
} as const;

/**
 * Every request sends `mip_opt_out=true` (`deepgram-params.ts`), which keeps customer audio
 * out of Deepgram's training set. Third-party reviews say opting out forfeits a 50% discount,
 * doubling the base rate; Deepgram's own pages do not say. Priced at the pessimistic 2x until
 * an invoice settles it — `cost/reconcile` prints the effective $/min to set this from.
 */
export const DEEPGRAM_OPT_OUT_MULTIPLIER = 2;

/** Micros (millionths of a dollar) per second of audio, by meter and by how it was sent. */
export function deepgramMicrosPerSecond(kind: SpeechKind, source: "stream" | "file"): number {
  const p = DEEPGRAM_LIST_PER_MINUTE;
  const base = (source === "stream" ? p.streaming : p.file) * DEEPGRAM_OPT_OUT_MULTIPLIER;
  // Diarization rides only on the live meeting socket; keyterms on everything, as the
  // ceiling — an account with no contacts sends none, and is priced a little high.
  const perMinute = base + p.keyterm + (kind === "meeting" && source === "stream" ? p.diarize : 0);
  return (perMinute / 60) * 1_000_000;
}

export type SpeechSecondsRow = { kind: SpeechKind; source: "stream" | "file"; seconds: number };

export function speechCostMicros(rows: readonly SpeechSecondsRow[]): number {
  let micros = 0;
  for (const row of rows) micros += Math.max(0, row.seconds) * deepgramMicrosPerSecond(row.kind, row.source);
  return Math.round(micros);
}

/**
 * The credit Orbit's Deepgram spend draws on: $15,000, one time, no renewal.
 *
 * Capped at 95%, the same headroom the AI pools keep (`MANAGED_AI_POOLS`): spend is measured
 * from `speech_usage`, which a closing tab's lost beacon can under-report, and meetings that
 * are already running are allowed to finish past the last rung.
 *
 * ponytail: a code constant, like the AI pools. When the credit is topped up or replaced,
 * raise `capMicros` (and move `since` if the new balance starts fresh) and redeploy.
 */
export type SpeechCredit = { creditMicros: number; capMicros: number; since: string };
export const DEEPGRAM_CREDIT: SpeechCredit = {
  creditMicros: 15_000_000_000,
  capMicros: 14_250_000_000,
  since: "2026-10-17T00:00:00Z",
};

/**
 * How Orbit gives way as the credit runs out — a ladder of degradations, never an outage.
 * Each rung moves the affected surface onto the path `ORBIT_DEEPGRAM=off` already uses: voice
 * notes fall back to the account's own OpenAI or Gemini key, the chat mic to the browser's own
 * speech recognition, and a new meeting to chunk transcription on the account's own key.
 *
 * Shares are of `capMicros`.
 */
export const SPEECH_CREDIT_LADDER = {
  /** Free accounts stop drawing on the credit. */
  freeOffShare: 0.9,
  /** Voice notes and the chat mic stop for every plan. */
  shortformOffShare: 0.97,
  /** No NEW meeting starts on Orbit's key. A meeting already recording finishes. */
  newMeetingsOffShare: 1,
} as const;

/** Where the ops sweep speaks up (`ops-alerts.ts`). */
export const SPEECH_CREDIT_ALERTS = {
  warnShares: [0.5, 0.75, 0.9] as const,
  criticalShare: 0.97,
  /** Credit left at the last 7 days' pace, below which the sweep warns. */
  runwayWarnDays: 45,
  /** One day's spend above this is a spike worth a look ($75: a fiftieth of a month at $3.7k). */
  dailySpikeMicros: 75_000_000,
} as const;

export function creditShare(spentMicros: number, credit: SpeechCredit = DEEPGRAM_CREDIT): number {
  return credit.capMicros > 0 ? Math.max(0, spentMicros) / credit.capMicros : 1;
}

/**
 * Whether this account may draw on the credit for this meter right now.
 *
 * `meetingInProgress` is a meeting that has already recorded audio on Deepgram: it keeps its
 * socket and its chunk recovery to the end, whatever the ladder says, so nobody's call is cut
 * off mid-sentence. Only starting a NEW one is refused at the last rung.
 */
export function creditAllows(input: {
  share: number;
  plan: Plan;
  kind: SpeechKind;
  meetingInProgress?: boolean;
}): boolean {
  const { share, plan, kind } = input;
  if (kind === "meeting") {
    return Boolean(input.meetingInProgress) || share < SPEECH_CREDIT_LADDER.newMeetingsOffShare;
  }
  if (share >= SPEECH_CREDIT_LADDER.shortformOffShare) return false;
  if (plan === "free" && share >= SPEECH_CREDIT_LADDER.freeOffShare) return false;
  return true;
}

/** Days of credit left at a given daily pace; null when nothing is being spent. */
export function creditRunwayDays(spentMicros: number, microsPerDay: number, credit: SpeechCredit = DEEPGRAM_CREDIT): number | null {
  if (microsPerDay <= 0) return null;
  return Math.max(0, credit.capMicros - spentMicros) / microsPerDay;
}
