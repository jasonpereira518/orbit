"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { clearImportJob, useImportJob } from "@/lib/import-job-runner";
import { TOAST_COPY } from "@/lib/toast-copy";
import { failureText } from "@/lib/errors";

/**
 * Lives in the app shell so background imports keep notifying after you leave
 * the Imports page. Shows bottom-right toasts when a job finishes.
 */
export function ImportJobWatcher() {
  const router = useRouter();
  const job = useImportJob();
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    if (!job) return;
    if (job.status === "running") return;
    if (handledId.current === job.id) return;
    handledId.current = job.id;

    if (job.status === "completed") {
      if (job.resultMessage) toast.success(job.resultMessage);
      if (job.enrichmentMessage) toast.message(job.enrichmentMessage);
      router.refresh();
    } else if (job.status === "cancelled") {
      if (job.resultMessage) toast.message(job.resultMessage);
      router.refresh();
    } else if (job.status === "failed") {
      // `job.error` is whatever the background runner stored, which can be raw — unless
      // `job.userFacingError` says it was already written to be read (see `failureText`).
      toast.error(
        failureText(job.error, job.userFacingError, TOAST_COPY.importFailed),
      );
    }

    // Keep snapshot briefly so the Imports page can clear local UI, then drop it.
    const t = window.setTimeout(() => {
      clearImportJob();
    }, 50);
    return () => window.clearTimeout(t);
  }, [job, router]);

  return null;
}
