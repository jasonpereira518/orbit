"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { CaptureFormSkeleton } from "@/components/loading/page-skeletons";
import type { CaptureFlow as CaptureFlowComponent } from "@/components/capture/capture-flow";

const CaptureFlow = dynamic(
  () => import("@/components/capture/capture-flow").then((m) => ({ default: m.CaptureFlow })),
  { loading: () => <CaptureFormSkeleton /> }
);

export function CaptureFlowLazy(props: ComponentProps<typeof CaptureFlowComponent>) {
  return <CaptureFlow {...props} />;
}
