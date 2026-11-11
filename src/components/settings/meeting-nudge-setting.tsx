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
      description={
        <>
          Before a Google Calendar meeting, offer to record · this device
          {on === null ? null : (
            <>
              {" · "}
              <span role="status">{on ? "On" : "Off"}</span>
            </>
          )}
        </>
      }
      action={
        <Button type="button" size="sm" variant="outline" disabled={on === null} onClick={() => setMeetingNudgeOn(!on)}>
          {on ? "Turn off" : "Turn on"}
        </Button>
      }
    />
  );
}
