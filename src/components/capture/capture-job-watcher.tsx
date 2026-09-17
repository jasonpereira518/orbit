"use client";

/**
 * Lives in the app shell, above the route template, so a capture that finishes while you
 * are on another page still lands in the notification center — and a save that lands
 * refreshes the contacts you are looking at.
 */
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { finishBackgroundJob, getBackgroundJob, startBackgroundJob } from "@/lib/background-jobs";
import { useCaptureJob } from "@/lib/capture/job-store";
import { countDecisions } from "@/lib/capture/review-reducer";

export function CaptureJobWatcher() {
  const router = useRouter();
  const { job } = useCaptureJob();
  const seen = useRef<{ id: string; status: string } | null>(null);

  useEffect(() => {
    if (!job) return;
    if (seen.current?.id === job.id && seen.current.status === job.status) return;
    const previous = seen.current?.id === job.id ? seen.current.status : null;
    seen.current = { id: job.id, status: job.status };

    const extractId = `capture-extract-${job.id}`;
    const saveId = `capture-save-${job.id}`;
    const n = job.result?.items.length ?? 0;

    if (job.status === "queued" || job.status === "extracting") {
      if (!getBackgroundJob(extractId)) {
        startBackgroundJob({ id: extractId, kind: "capture-extract", label: "Reading your notes", startedAt: Date.now(), done: 0, total: 0 });
      }
    } else if (job.status === "ready" && getBackgroundJob(extractId)) {
      finishBackgroundJob(extractId, {
        status: "completed",
        resultMessage: n === 0 ? "Nothing to review — just dates" : `${n} ${n === 1 ? "person" : "people"} ready to review`,
      });
    } else if (job.status === "saving") {
      const counts = countDecisions(job.result?.items ?? [], job.decisions);
      if (!getBackgroundJob(saveId)) {
        startBackgroundJob({
          id: saveId,
          kind: "capture-save",
          label: counts.accepted ? `Saving ${counts.accepted} ${counts.accepted === 1 ? "contact" : "contacts"}` : "Saving your capture",
          startedAt: Date.now(),
          done: 0,
          total: 0,
        });
      }
    } else if (job.status === "saved") {
      const saved = job.result?.saved;
      const message = saved
        ? `Saved: ${saved.created} created, ${saved.updated} updated, ${saved.remindersCreated} ${saved.remindersCreated === 1 ? "reminder" : "reminders"}`
        : "Saved";
      if (getBackgroundJob(saveId)) finishBackgroundJob(saveId, { status: "completed", resultMessage: message });
      if (previous === "saving") router.refresh();
    } else if (job.status === "failed") {
      const error = job.error ?? "Couldn’t finish that capture — try again?";
      if (getBackgroundJob(extractId)) finishBackgroundJob(extractId, { status: "failed", error });
      if (getBackgroundJob(saveId)) finishBackgroundJob(saveId, { status: "failed", error });
    } else if (job.status === "discarded") {
      if (getBackgroundJob(extractId)) finishBackgroundJob(extractId, { status: "cancelled", resultMessage: "Capture cleared" });
    }
  }, [job, router]);

  return null;
}
