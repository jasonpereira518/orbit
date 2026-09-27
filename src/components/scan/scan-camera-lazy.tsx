"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { VIEWFINDER_STYLE } from "@/components/scan/viewfinder";

/**
 * `getUserMedia`, the canvas encoder and (via the panel) pdfjs are all only needed by
 * someone who actually scans something, so none of them should sit in the bundle every
 * signed-in user downloads. Same convention as `capture-form-lazy` and `feedback-widget-lazy`.
 */
export const ScanCameraLazy = dynamic(
  () => import("@/components/scan/scan-camera").then((m) => ({ default: m.ScanCamera })),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-3">
        <Skeleton className="mx-auto rounded-2xl" style={VIEWFINDER_STYLE} />
        <Skeleton className="h-9 w-32" />
      </div>
    ),
  }
);
