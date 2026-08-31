/**
 * The stage vocabulary for a hiring process, and the rule for combining two observations of
 * the same process into one.
 *
 * Pure and dependency-free on purpose: both the cheap ATS rules and the LLM classifier emit
 * stages, and an opportunity is assembled from many threads arriving out of order across
 * several scans. One merge rule shared by every writer is what keeps a pipeline from
 * flickering as old mail is re-read.
 */

export const RECRUITER_STAGES = [
  "outreach_received",
  "outreach_sent",
  "applied",
  "in_conversation",
  "screening",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export type RecruiterStage = (typeof RECRUITER_STAGES)[number];

/**
 * How far along a stage is. Ties are fine — `outreach_sent` and `outreach_received` are the
 * same distance into a process, they just say who moved first.
 *
 * Terminal stages are deliberately absent: they do not compete on progress, they end things.
 */
const STAGE_RANK: Record<RecruiterStage, number> = {
  outreach_received: 10,
  outreach_sent: 10,
  applied: 20,
  in_conversation: 30,
  screening: 40,
  interviewing: 50,
  offer: 60,
  rejected: 0,
  withdrawn: 0,
};

const TERMINAL_STAGES = new Set<RecruiterStage>(["rejected", "withdrawn"]);

export function isTerminalStage(stage: RecruiterStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export function isRecruiterStage(value: string): value is RecruiterStage {
  return (RECRUITER_STAGES as readonly string[]).includes(value);
}

export type StageObservation = {
  stage: RecruiterStage;
  /** When the evidence for this stage was written, not when it was read. */
  at: Date;
};

/**
 * Folds a new observation into the stage a process is already known to be at.
 *
 * Progress is monotonic — re-reading an old "thanks for applying" must not drag a live
 * interview loop backwards, which is the failure mode of taking whichever row was processed
 * last. Terminal stages override any progress stage, but only from their own point forward:
 * a rejection followed months later by a fresh screen is a real thing that happens, and the
 * date comparison is what lets the pipeline show it instead of staying frozen at `rejected`.
 */
export function mergeStage(
  current: StageObservation | null,
  incoming: StageObservation
): StageObservation {
  if (!current) return incoming;

  const currentTerminal = isTerminalStage(current.stage);
  const incomingTerminal = isTerminalStage(incoming.stage);

  if (currentTerminal || incomingTerminal) {
    // Whichever happened later describes the process now. A terminal stage does not
    // outrank a genuinely newer event; it only outranks older ones.
    return incoming.at > current.at ? incoming : current;
  }

  if (STAGE_RANK[incoming.stage] > STAGE_RANK[current.stage]) return incoming;
  if (STAGE_RANK[incoming.stage] < STAGE_RANK[current.stage]) return current;
  // Equal rank: prefer the more recent, so `outreach_sent` yields to a same-day reply.
  return incoming.at > current.at ? incoming : current;
}

/** Human-facing label. Kept next to the vocabulary so the two cannot drift. */
export const STAGE_LABELS: Record<RecruiterStage, string> = {
  outreach_received: "They reached out",
  outreach_sent: "You reached out",
  applied: "Applied",
  in_conversation: "In conversation",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
