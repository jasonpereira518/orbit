"use client";

/**
 * "Pilot sync starts in 2 min — record it?" in the bottom-right stack, about two minutes
 * before a calendar meeting. The data and timing are `meeting-nudge-store.ts`; this is only
 * how it looks and what its buttons do.
 *
 * "Open recorder" fills the setup form from the event and goes to /capture's Meeting tab.
 * Starting is still a click there — the browser's share picker needs a user gesture — so the
 * nudge cannot (and should not) begin recording on its own.
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
            {snap.timing}
            {nudge.attendees.length > 0
              ? ` · with ${nudge.attendees[0].name}${nudge.attendees.length > 1 ? ` +${nudge.attendees.length - 1}` : ""}`
              : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={open}>
          Open recorder
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => dismissMeetingNudge(nudgeKey(nudge))}>
          Not now
        </Button>
        <button
          type="button"
          className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
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
