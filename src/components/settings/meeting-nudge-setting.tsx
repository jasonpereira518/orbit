"use client";

import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/settings-section";
import { setMeetingNudgeOn, useMeetingNudgeSetting } from "@/lib/meeting-nudge-store";

/**
 * Whether Orbit offers to record a meeting a couple of minutes before it starts. Per device
 * (it lives in this browser, like the notification sound), because it is about this screen.
 */
export function MeetingNudgeSetting() {
  const on = useMeetingNudgeSetting();

  return (
    <SettingsRow
      title="Offer to record meetings"
      description="A couple of minutes before a meeting on your Google Calendar, Orbit offers to open the recorder with the title and guests filled in. It needs Google Calendar connected and a plan with meeting recording, and it only appears while Orbit is open in a tab — turn on desktop notifications above to hear about it from another tab. This is saved on this device."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={on === null} onClick={() => setMeetingNudgeOn(!on)}>
          {on ? "Turn off" : "Turn on"}
        </Button>
        <span className="text-sm text-muted-foreground" role="status">
          {on === null ? "" : on ? "On" : "Off"}
        </span>
      </div>
    </SettingsRow>
  );
}
