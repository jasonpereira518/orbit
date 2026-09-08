"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

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
        <Skeleton className="aspect-[4/3] w-full rounded-2xl" />
        <Skeleton className="h-9 w-32" />
      </div>
    ),
  }
);
