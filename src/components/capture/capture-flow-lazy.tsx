"use client";

import dynamic from "next/dynamic";
import { createContext, useContext, type ComponentProps } from "react";
import { CaptureFormSkeleton, MeetingCaptureSkeleton } from "@/components/loading/page-skeletons";
import type { CaptureFlow as CaptureFlowComponent } from "@/components/capture/capture-flow";

const CaptureFlow = dynamic(
  () => import("@/components/capture/capture-flow").then((m) => ({ default: m.CaptureFlow })),
  { loading: () => <CaptureFormSkeleton /> }
);

// `dynamic`'s `loading` component gets no props, so the Meetings placeholder learns whether
// the real card will carry the AI-key notice (and so be ~90px taller) through context.
const MeetingNoticeHint = createContext(false);
function MeetingsLoading() {
  return <MeetingCaptureSkeleton notice={useContext(MeetingNoticeHint)} />;
}
const MeetingsCaptureFlow = dynamic(
  () => import("@/components/capture/capture-flow").then((m) => ({ default: m.CaptureFlow })),
  { loading: () => <MeetingsLoading /> }
);

/** The capture form's code, fetched ahead of a click on anything that opens /capture. */
export function preloadCaptureFlow() {
  void import("@/components/capture/capture-flow").catch(() => {});
}

export function CaptureFlowLazy(props: ComponentProps<typeof CaptureFlowComponent>) {
  if (props.variant === "meetings") {
    return (
      <MeetingNoticeHint.Provider value={!props.hasApiKey || !props.canTranscribe}>
        <MeetingsCaptureFlow {...props} />
      </MeetingNoticeHint.Provider>
    );
  }
  return <CaptureFlow {...props} />;
}
