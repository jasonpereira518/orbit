import type { SignalKind, SignalTrigger } from "./types";

/**
 * Which side of the 7-day hard filter each kind falls on. Every kind must appear —
 * `Record` makes a missing one a compile error, which is the point.
 */
export const SIGNAL_TRIGGER: Record<SignalKind, SignalTrigger> = {
  commitment_due: "date",
  scheduled_follow_up: "date",
  birthday: "date",
  personal_date: "date",
  met_anniversary: "date",
  work_anniversary: "date",
  job_change: "date",
  open_loop: "staleness",
  dormant: "staleness",
  thread_quiet: "staleness",
  post_event: "staleness",
  never_contacted: "staleness",
  job_opening: "staleness",
};

export const BASE_PRIOR: Record<SignalKind, number> = {
  commitment_due: 95,
  scheduled_follow_up: 90,
  birthday: 85,
  open_loop: 80,
  job_change: 80,
  post_event: 70,
  personal_date: 60,
  work_anniversary: 55,
  met_anniversary: 50,
  thread_quiet: 50,
  job_opening: 45,
  dormant: 45,
  never_contacted: 40,
};

/**
 * Idle days before `dormant` fires, by closeness tier.
 *
 * Replaces a single flat 30-day threshold, which is the main reason today's outreach
 * suggestions read as wrong: a yearly acquaintance and a weekly collaborator are not
 * both overdue on day 31.
 */
export const DORMANT_DAYS: Record<"inner" | "mid" | "outer" | "unknown", number> = {
  inner: 30,
  mid: 90,
  outer: 180,
  unknown: 90,
};
