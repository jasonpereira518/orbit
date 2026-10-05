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

/** Attachments (P4). Totals are raw bytes, before base64. */
export const MAX_ATTACHMENTS = 10;
/** Gmail: 20 MB raw ≈ 27 MB as base64 MIME — under the 35 MB upload cap and Gmail's 25 MB attachment rule. */
export const MAX_ATTACHMENT_BYTES_GMAIL = 20 * 1024 * 1024;
/** Outlook with Mail.Send only: attachments ride inline in sendMail, which takes ~3 MB (P3 decision 1). */
export const MAX_ATTACHMENT_BYTES_OUTLOOK = 3 * 1024 * 1024;
export const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ORPHAN_UPLOAD_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** Scheduled send bounds (P4). */
export const SCHEDULE_MIN_LEAD_MS = 60_000;
export const SCHEDULE_MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

/** Outlook replies go as MIME, base64 twice over inside Graph's ~4 MB request (P5). */
export const MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY = 2 * 1024 * 1024;

export function maxAttachmentBytesFor(provider: "gmail" | "outlook" | "demo", opts: { reply?: boolean } = {}): number {
  if (provider !== "outlook") return MAX_ATTACHMENT_BYTES_GMAIL;
  return opts.reply ? MAX_ATTACHMENT_BYTES_OUTLOOK_REPLY : MAX_ATTACHMENT_BYTES_OUTLOOK;
}
