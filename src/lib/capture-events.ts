import type { CAPTURE_SOURCES } from "@/lib/product-event-schemas";
import { track } from "@/lib/product-events";
import { eventId } from "@/lib/product-event-ids";
import { captureSourceKinds } from "@/lib/note-batches";
import type { CaptureJobSource } from "@/lib/capture/types";

/**
 * `capture_*` product events, in one place so every writer of a capture job's outcome
 * (the runner, the stall sweep, the discard actions) records the same shape.
 *
 * Ids and counts only. The error is a machine code (`eventErrorKind`), never its message.
 */

type EventSource = (typeof CAPTURE_SOURCES)[number];

type JobForEvent = {
  id: string;
  userId: string;
  sourceKind: CaptureJobSource;
  sources: string[] | null;
};

/** The event's `source_kind`: how the notes arrived, from the job's own provenance labels. */
export function captureEventSource(job: Pick<JobForEvent, "sourceKind" | "sources">): EventSource {
  switch (job.sourceKind) {
    case "meeting":
      return "meeting";
    case "voice":
      return "voice";
    case "scan":
    case "phone":
      return "photo";
    case "api":
      return "text";
    default: {
      const kinds = captureSourceKinds(job.sources);
      if (kinds.includes("voice")) return "voice";
      if (kinds.includes("photo")) return "photo";
      if (kinds.includes("file") || kinds.includes("calendar") || kinds.includes("email")) return "file";
      return "text";
    }
  }
}

export function trackCaptureSaved(job: JobForEvent, counts: { created: number; updated: number }): void {
  track(
    "capture_saved",
    {
      capture_job_id: job.id,
      source_kind: captureEventSource(job),
      people_created: counts.created,
      people_updated: counts.updated,
    },
    // One per job, whatever retries or resumes reach the save.
    { userId: job.userId, id: eventId("capture_saved", job.id) }
  );
}

export function trackCaptureFailed(
  job: JobForEvent,
  stage: "ingest" | "parse" | "save",
  errorKind: string,
  /** Distinguishes attempts: a job can fail, be retried, and fail again. Defaults to once per (job, stage, kind). */
  attempt?: string
): void {
  track(
    "capture_failed",
    { capture_job_id: job.id, source_kind: captureEventSource(job), stage, error_kind: errorKind },
    // A system outcome (the runner), not something the person did.
    { userId: job.userId, actor: "system", id: eventId("capture_failed", job.id, stage, errorKind, attempt ?? "") }
  );
}

export function trackCaptureDiscarded(job: Pick<JobForEvent, "id" | "userId">, peopleProposed: number): void {
  track(
    "capture_discarded",
    { capture_job_id: job.id, people_proposed: peopleProposed },
    { userId: job.userId, id: eventId("capture_discarded", job.id) }
  );
}
