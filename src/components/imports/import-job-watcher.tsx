"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import {
  clearImportJob,
  useImportJob,
} from "@/lib/import-job-runner";

/**
 * Module-level, not a ref: the shell (or this component) can remount while a finished job's
 * snapshot is still in the store, since the clear timer below is cancelled on cleanup. A
 * per-mount ref forgot the job and announced it again, once per remount.
 */
const handledJobIds = new Set<string>();

/**
 * Lives in the app shell so background imports keep notifying after you leave
 * the Imports page. Shows bottom-right toasts when a job finishes.
 */
export function ImportJobWatcher() {
  const router = useRouter();
  const job = useImportJob();

  useEffect(() => {
    if (!job) return;
    if (job.status === "running") return;
    // Cleared by the timer below either way: if we already announced this job (a remount
    // saw its lingering snapshot), just drop it without another toast.
    if (handledJobIds.has(job.id)) {
      clearImportJob();
      return;
    }
    handledJobIds.add(job.id);
    // Stable ids make sonner replace, not stack, if anything still slips through.
    const toastId = `import-${job.id}`;

    if (job.status === "completed") {
      if (job.resultMessage) toast.success(job.resultMessage, { id: toastId });
      if (job.enrichmentMessage) toast.message(job.enrichmentMessage, { id: `${toastId}-enrichment` });
      router.refresh();
    } else if (job.status === "cancelled") {
      if (job.resultMessage) toast.message(job.resultMessage, { id: toastId });
      router.refresh();
    } else if (job.status === "failed") {
      toast.error(job.error || "Import failed", { id: toastId });
    }

    // Keep snapshot briefly so the Imports page can clear local UI, then drop it.
    const t = window.setTimeout(() => {
      clearImportJob();
    }, 50);
    return () => window.clearTimeout(t);
  }, [job, router]);

  return null;
}
