"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

const CaptureForm = dynamic(
  () =>
    import("@/components/capture/capture-form").then((m) => ({
      default: m.CaptureForm,
    })),
  {
    loading: () => <Skeleton className="h-64 w-full rounded-2xl" />,
  }
);

export function CaptureFormLazy({
  initialContactId = null,
  initialContactName = null,
  defaultMode = "messy",
}: {
  initialContactId?: string | null;
  initialContactName?: string | null;
  defaultMode?: "messy" | "structured";
}) {
  return (
    <CaptureForm
      initialContactId={initialContactId}
      initialContactName={initialContactName}
      defaultMode={defaultMode}
    />
  );
}
