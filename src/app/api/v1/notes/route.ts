/**
 * Send a note into Orbit.
 *
 * Enqueues a capture job rather than writing contacts directly: extracting people, dates and
 * commitments is the app's AI pipeline, and a second implementation behind the API would
 * drift from it immediately. The caller gets the job id and can poll, or simply forget it —
 * the result shows up in the app's capture queue either way.
 */
import { apiHandler, apiOk, readJson } from "@/lib/api/http";
import { noteBody } from "@/lib/api/schemas";
import { createCaptureJob } from "@/lib/capture-jobs";
import { runCaptureJobById } from "@/lib/capture-job-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const body = await readJson(request, noteBody);
  const job = await createCaptureJob(caller.userId, {
    sourceKind: "messy",
    status: "queued",
    inputText: body.text,
    sourceLabel: body.sourceLabel ?? "API",
    seedContactId: body.contactId ?? null,
  });
  // Fire and forget: the drain and the app's own poller both resume a stalled job, so a
  // dropped kick costs latency and never the note.
  void runCaptureJobById(job.id).catch(() => null);
  return apiOk({ noteId: job.id, status: "queued" }, { status: 202 });
});
