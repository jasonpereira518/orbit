"use client";

import { useEffect, useState, useTransition } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
      <div className="flex flex-wrap items-center gap-3">
        <Switch id="radar-digest" checked={enabled} disabled={pending} onCheckedChange={toggle} />
        <Label htmlFor="radar-digest" className="text-sm font-normal text-muted-foreground">
          <span role="status">{pending ? "Saving…" : enabled ? "On" : "Off"}</span>
        </Label>
      </div>
    </SettingsRow>
  );
}
