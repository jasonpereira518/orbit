"use client";

/**
 * "Pilot sync starts in 5 min — record it?" in the bottom-right stack, about five minutes
 * before a calendar meeting. The data and timing are `meeting-nudge-store.ts`; this is only
 * how it looks and what its buttons do.
 *
 * "Record" fills the setup form from the event and starts sharing right here: the click IS
 * the user gesture the browser's share picker needs, and the picker is still the person's own
 * choice of what to share. Nothing starts without that click. Until the recorder chunk has
 * loaded, the only button is "Open recorder", which fills the form and goes to /capture.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { nudgeKey } from "@/lib/meeting-nudge";
import {
  dismissMeetingNudge,
  setMeetingNudgeOn,
  skipMeetingSeries,
  useMeetingNudgeOn,
  useMeetingNudgeSnapshot,
  type NudgeSnapshot,
} from "@/lib/meeting-nudge-store";
import { preloadMeetingEngine, useMeetingFlow, useMeetingSession } from "@/components/capture/meeting-session";

/**
 * The offer to render, or null. Null while a meeting is already being recorded or the full
 * panel is on screen (it has its own calendar card), when this device turned the nudge off,
 * and for accounts without meeting recording — which never start the poll.
 */
export function useMeetingNudgeCard(): NudgeSnapshot | null {
  const flow = useMeetingFlow();
  const on = useMeetingNudgeOn();
  const snap = useMeetingNudgeSnapshot(Boolean(flow?.canUseMeetings) && on);
  if (!flow || !on || !snap.nudge || flow.busy || flow.panelOpen) return null;
  return snap;
}

export function MeetingNudgeCard({ snap }: { snap: NudgeSnapshot }) {
  const session = useMeetingSession();
  const router = useRouter();
  const nudge = snap.nudge;

  // The recorder is a lazy chunk; have it on its way before they click through.
  useEffect(() => preloadMeetingEngine(), []);

  if (!nudge || !session) return null;

  const open = () => {
    session.applyCalendarMeeting(nudge);
    dismissMeetingNudge(nudgeKey(nudge));
    router.push("/capture?mode=meeting");
  };

  const record = () => {
    session.applyCalendarMeeting(nudge);
    dismissMeetingNudge(nudgeKey(nudge));
    // Synchronous from the click to `getDisplayMedia`. The form state set above lands before
    // the share resolves, which is when the session is created from it.
    session.startRecording(null, "display");
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-card/95 p-3 shadow-lg backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{nudge.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {nudge.webinar ? "Webinar · " : ""}
            {snap.timing}
            {nudge.attendees.length > 0
              ? ` · with ${nudge.attendees[0].name}${nudge.attendees.length > 1 ? ` +${nudge.attendees.length - 1}` : ""}`
              : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {session.ready ? (
          <>
            <Button type="button" size="sm" onClick={record}>
              Record
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={open}>
              Open recorder
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" onClick={open}>
            Open recorder
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => dismissMeetingNudge(nudgeKey(nudge))}>
          Not now
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {nudge.seriesId && (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => {
              skipMeetingSeries(nudge.seriesId!);
              toast.info("Won’t ask about this series again on this device");
            }}
          >
            Skip this series
          </button>
        )}
        <button
          type="button"
          className="ml-auto underline-offset-2 hover:underline"
          onClick={() => {
            setMeetingNudgeOn(false);
            toast.info("Meeting reminders are off — turn them back on in Settings");
          }}
        >
          Don&apos;t ask again
        </button>
      </div>
    </div>
  );
}
