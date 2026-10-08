"use client";

/**
 * The Meeting tab: a view of the recorder in `MeetingSessionProvider`. The capture flow
 * collects the finished analysis from that provider (`claimAnalysis`).
 */
import { useSyncExternalStore } from "react";
import { MeetingCapturePanel } from "@/components/capture/meeting-capture-panel";
import { LockedFeature } from "@/components/locked-feature";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import { isMeetingCaptureSupported, isMicMeetingCaptureSupported } from "@/lib/use-meeting-recorder";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

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

const noop = () => () => {};

function useMicMeetingSupported(): boolean {
  return useSyncExternalStore(noop, isMicMeetingCaptureSupported, () => false);
}

export function MeetingCaptureTab({
  resumable,
  hasApiKey,
  aiReason = null,
  canTranscribe,
  canUseMeetings,
  meetingsDeniedMessage,
  panelId,
  tabId,
}: {
  resumable: ResumableMeeting | null;
  hasApiKey: boolean;
  aiReason?: AiAccessDenial | null;
  canTranscribe: boolean;
  /** Meeting recording is on Orbit Pro, Max and Lifetime. False renders an upgrade prompt instead of the recorder. */
  canUseMeetings: boolean;
  /** `FEATURE_DENIAL.meetings`, read on the server and threaded down — this is a client
   * component and cannot import `@/lib/entitlements` (it reaches the database). */
  meetingsDeniedMessage: string;
  panelId: string;
  tabId: string;
}) {
  const supported = useMeetingCaptureSupported();
  const micSupported = useMicMeetingSupported();
  return (
    <div id={panelId} role="tabpanel" aria-labelledby={tabId}>
      {canUseMeetings ? (
        <MeetingCapturePanel
          resumable={resumable}
          hasApiKey={hasApiKey}
          aiReason={aiReason}
          canTranscribe={canTranscribe}
          captureSupported={supported}
          micSupported={micSupported}
        />
      ) : (
        <LockedFeature
          title="Meeting transcription"
          description={meetingsDeniedMessage}
          highlights={[
            "Record calls straight from the browser",
            "Live transcription while the meeting runs",
            "An AI summary with attendees and follow-ups",
            "Turns straight into logged interactions",
          ]}
        />
      )}
    </div>
  );
}
