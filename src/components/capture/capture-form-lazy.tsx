"use client";

import dynamic from "next/dynamic";
import { CaptureFormSkeleton } from "@/components/loading/page-skeletons";
import type { CaptureMode } from "@/components/capture/capture-form";
import type { ResumableMeeting } from "@/lib/meeting-sessions";

const CaptureForm = dynamic(
  () =>
    import("@/components/capture/capture-form").then((m) => ({
      default: m.CaptureForm,
    })),
  {
    loading: () => <CaptureFormSkeleton />,
  }
);

export function CaptureFormLazy({
  initialContactId = null,
  initialContactName = null,
  defaultMode = "messy",
  hasApiKey = true,
  canTranscribe = false,
  resumableMeeting = null,
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: CaptureMode;
  hasApiKey?: boolean;
  canTranscribe?: boolean;
  resumableMeeting?: ResumableMeeting | null;
}) {
  return (
    <CaptureForm
      initialContactId={initialContactId}
      initialContactName={initialContactName}
      defaultMode={defaultMode}
      hasApiKey={hasApiKey}
      canTranscribe={canTranscribe}
      resumableMeeting={resumableMeeting}
    />
  );
}
