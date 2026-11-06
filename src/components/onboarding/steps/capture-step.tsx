"use client";

import { CaptureFlowLazy } from "@/components/capture/capture-flow-lazy";
import type { CaptureJobView } from "@/lib/capture-jobs";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

/**
 * /capture's own flow, notes only. Extracting writes a durable capture job, so a reload
 * mid-review comes back to the same cards (`initialJob`), exactly as /capture resumes.
 */
export function CaptureStep({
  initialJob,
  hasApiKey,
  aiReason,
  onSaved,
}: {
  initialJob: CaptureJobView | null;
  hasApiKey: boolean;
  aiReason: AiAccessDenial | null;
  onSaved: () => void;
}) {
  return (
    <CaptureFlowLazy
      initialJob={initialJob}
      hasApiKey={hasApiKey}
      aiReason={aiReason}
      meetingsDeniedMessage=""
      onSaved={onSaved}
    />
  );
}
