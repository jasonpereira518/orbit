import type { CaptureJobStatus } from "./types";

/** How long an idle, unfinished draft still auto-opens on /capture and /meetings. */
export const STALE_DRAFT_MS = 2 * 60 * 60 * 1000;

export type AutoOpenJobInput = {
  status: CaptureJobStatus;
  updatedAt: Date;
  /** People/items in the job's result; 0 when it has none yet. */
  itemCount: number;
};

/**
 * Whether a saved job should open by itself. An explicit `?job=` always does, and so does
 * work still in flight. A `ready`/`reviewing` draft opens only while fresh: a days-old one
 * is the caller's to offer as a resume notice instead of ambushing the page.
 * `itemCount` is deliberately not used yet: a stale draft stays closed with or without items.
 */
export function shouldAutoOpenJob(
  job: AutoOpenJobInput,
  opts: { explicitJobParam: boolean; now: Date },
): boolean {
  if (opts.explicitJobParam) return true;
  if (job.status !== "ready" && job.status !== "reviewing") return true;
  return opts.now.getTime() - job.updatedAt.getTime() <= STALE_DRAFT_MS;
}
