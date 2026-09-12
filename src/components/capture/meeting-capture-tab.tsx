"use client";

/**
 * The Meeting tab: the existing recorder machine, handing its analysis to the capture
 * flow instead of mounting the old review panel.
 */
import { useSyncExternalStore } from "react";
import { MeetingCapturePanel } from "@/components/capture/meeting-capture-panel";
import type { MeetingAnalysis } from "@/actions/meetings";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import { isMeetingCaptureSupported } from "@/lib/use-meeting-recorder";

/**
 * Whether this browser can record a call. Only knowable on the client, so the server
 * snapshot is `false` and the setup card adapts after hydration.
 */
function useMeetingCaptureSupported(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(min-width: 768px) and (pointer: fine)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    isMeetingCaptureSupported,
    () => false
  );
}

export function MeetingCaptureTab({
  resumable,
  hasApiKey,
  canTranscribe,
  onBusyChange,
  onAnalyzed,
  panelId,
  tabId,
}: {
  resumable: ResumableMeeting | null;
  hasApiKey: boolean;
  canTranscribe: boolean;
  onBusyChange: (busy: boolean) => void;
  onAnalyzed: (analysis: MeetingAnalysis, sessionId: string) => void;
  panelId: string;
  tabId: string;
}) {
  const supported = useMeetingCaptureSupported();
  return (
    <div id={panelId} role="tabpanel" aria-labelledby={tabId}>
      <MeetingCapturePanel
        resumable={resumable}
        hasApiKey={hasApiKey}
        canTranscribe={canTranscribe}
        captureSupported={supported}
        onBusyChange={onBusyChange}
        onAnalyzed={onAnalyzed}
      />
    </div>
  );
}
