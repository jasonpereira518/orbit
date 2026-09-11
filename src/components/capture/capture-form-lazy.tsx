"use client";

import dynamic from "next/dynamic";
import { CaptureFormSkeleton } from "@/components/loading/page-skeletons";
import type { CaptureMode } from "@/components/capture/capture-form";

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
  userId,
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: CaptureMode;
  hasApiKey?: boolean;
  /** Scopes the autosaved draft to this account — see `captureDraftKey`. */
  userId: string;
}) {
  return (
    <CaptureForm
      initialContactId={initialContactId}
      initialContactName={initialContactName}
      defaultMode={defaultMode}
      hasApiKey={hasApiKey}
      userId={userId}
    />
  );
}
