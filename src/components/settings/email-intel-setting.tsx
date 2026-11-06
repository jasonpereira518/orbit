"use client";

import { useState, useTransition } from "react";
import { setEmailIntel } from "@/actions/email-intel";
import { startGmailOAuth } from "@/actions/gmail";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/settings-section";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * Email insights: Orbit checks new job and hiring-process threads in Gmail and notes where
 * each application stands. Shown only to viewers who can open Radar.
 */
export function EmailIntelSetting({
  initialEnabled,
  canRead,
  allowed,
}: {
  initialEnabled: boolean;
  /** The connected Gmail grant already covers mail access. */
  canRead: boolean;
  /** The plan includes it (same as the recruiter scan). */
  allowed: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, start] = useTransition();

  const toggle = () =>
    start(async () => {
      const next = !enabled;
      try {
        if (next && !canRead) {
          // Mail access is asked for only here, never on everyday Connect.
          const { url } = await startGmailOAuth({ purpose: "email_intel", returnTo: "/settings" });
          window.location.href = url;
          return;
        }
        const result = await setEmailIntel(next);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        setEnabled(next);
        toast.success(next ? "Email insights on" : "Email insights off");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });

  return (
    <SettingsRow
      title="Email insights"
      description="Every fifteen minutes Orbit checks Gmail for new job and hiring-process threads. For a hiring conversation it reads the latest messages, sends them to your AI provider to note the company, role, where things stand, dates and people, and keeps those notes and one short quote — never the messages themselves."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={pending || !allowed} onClick={toggle}>
          {enabled ? "Turn off" : canRead ? "Turn on" : "Allow mail access"}
        </Button>
        <span className="text-sm text-muted-foreground" role="status">
          {!allowed ? "Available on Orbit Pro and Orbit Max" : enabled ? "On" : "Off"}
        </span>
      </div>
    </SettingsRow>
  );
}
