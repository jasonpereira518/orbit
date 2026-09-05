"use client";

import dynamic from "next/dynamic";
import { CaptureFormSkeleton } from "@/components/loading/page-skeletons";

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
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: "messy" | "structured";
  hasApiKey?: boolean;
}) {
  return (
    <CaptureForm
      initialContactId={initialContactId}
      initialContactName={initialContactName}
      defaultMode={defaultMode}
      hasApiKey={hasApiKey}
    />
  );
}
