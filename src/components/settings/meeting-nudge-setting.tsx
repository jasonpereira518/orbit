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
      description="Before a Google Calendar meeting, Orbit offers to start the recorder with the title and guests filled in. Needs Google Calendar. This device only."
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
