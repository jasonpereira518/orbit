"use client";

import { useState, useTransition } from "react";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import {
  setEmailActivitySync,
  type EmailActivityStatus,
} from "@/actions/email-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * The opt-in for reading a connected mailbox as relationship activity.
 *
 * Off by default, and phrased so the trade is legible before the click rather than after it:
 * what is read, what is stored, and what is not. People connect Google to import contacts,
 * sync a calendar or send a follow-up — none of which is consent to have their mail read,
 * and "it is only metadata" is not a reason to skip asking.
 */
export function EmailActivityPanel({ status }: { status: EmailActivityStatus }) {
  const [enabled, setEnabled] = useState(status.enabled);
  const [pending, start] = useTransition();

  function toggle(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    start(async () => {
      try {
        await setEmailActivitySync(next);
        toast.success(next ? "Email activity on" : "Email activity off");
      } catch (err) {
        setEnabled(previous);
        toast.error(friendlyError(err, "Couldn’t save that — try again?"));
      }
    });
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Keeps “last spoken” honest by reading who you exchanged mail with and when, so the follow-up queue stops
          chasing people you emailed last week.
        </p>
        {enabled ? (
          <Badge tone="success" className="shrink-0">
            On
          </Badge>
        ) : null}
      </div>

      <ul className="space-y-1.5 text-sm text-muted-foreground">
        <li>
          Reads <span className="text-foreground">who and when</span> — sender, recipients,
          subject and date. Never the message body.
        </li>
        <li>
          Records activity only against{" "}
          <span className="text-foreground">people already in your network</span>. It never
          adds contacts, so newsletters and recruiter blasts stay out.
        </li>
        <li>
          Skips automated senders, mass emails, and anything older than 90 days on the first
          run.
        </li>
      </ul>

      {!status.connected ? (
        <p className="rounded-xl border border-dashed border-border-subtle px-4 py-3 text-sm text-muted-foreground">
          Connect Google above first — this reads the mailbox you connect there.
        </p>
      ) : !status.hasScope ? (
        <p className="rounded-xl border border-dashed border-border-subtle px-4 py-3 text-sm text-muted-foreground">
          Your Google connection predates mail access. Reconnect Google to enable this.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant={enabled ? "outline" : "default"}
            disabled={pending}
            onClick={() => toggle(!enabled)}
          >
            {pending ? "Saving…" : enabled ? "Turn off" : "Turn on"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {status.emailAddress ? `Reading ${status.emailAddress}` : "Mailbox connected"}
            {status.lastSyncedAt
              ? ` · last checked ${new Date(status.lastSyncedAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>
      )}
    </section>
  );
}
