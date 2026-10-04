"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/settings-section";
import { setRadarDigest } from "@/actions/radar";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { syncTimeZoneCookie } from "@/lib/tz-cookie";

/** Radar's Monday email. Shown only to viewers who can open Radar. */
export function RadarDigestSetting({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, start] = useTransition();

  // The email is timed by this browser's zone; keep the cookie the server reads current.
  useEffect(() => syncTimeZoneCookie(), []);

  const toggle = () =>
    start(async () => {
      const next = !enabled;
      try {
        const result = await setRadarDigest(next);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        setEnabled(next);
        toast.success(result.message ?? (next ? "Monday email on" : "Monday email off"));
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });

  return (
    <SettingsRow
      title="Radar’s Monday email"
      description="Your week’s top people to write to, and how many drafts are waiting, early on Monday in your time zone. Nothing is sent to anyone else."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={toggle}>
          {enabled ? "Turn off" : "Turn on"}
        </Button>
        <span className="text-sm text-muted-foreground" role="status">
          {enabled ? "On" : "Off"}
        </span>
      </div>
    </SettingsRow>
  );
}
