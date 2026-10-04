import type { Plan } from "@/lib/plan-limits";

/**
 * The numbers every 1:1 send obeys. One cap across every origin (compose, follow-ups,
 * chat, agent approvals, recruiters) — see the direct-email spec §3. Pure: no DB, no
 * next/server, safe for client and pure smokes.
 */
export const EMAIL_SEND_DAILY_CAP: Record<Plan, number> = {
  free: 20,
  orbit: 100,
  max: 100,
  lifetime: 100,
};

/** How long an interactive send waits before it goes out — the Undo window. */
export const UNDO_DELAY_MS = 10_000;

export const MAX_RECIPIENTS = 20;
export const MAX_EMAIL_ATTEMPTS = 5;
/** Claim lease. Longer than one provider call (20s timeout) with margin; DB clock. */
export const EMAIL_LEASE_SECONDS = 120;
/** Nominal retry ladder. The drain runs every ten minutes, so the first steps collapse. */
export const EMAIL_BACKOFF_MINUTES = [1, 5, 30, 120] as const;

/** Seconds to wait before retrying after attempt number `attempt` (1-based) failed. */
export function emailBackoffSeconds(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), EMAIL_BACKOFF_MINUTES.length) - 1;
  return EMAIL_BACKOFF_MINUTES[i]! * 60;
}
