"use client";

import { useState, useTransition } from "react";
import { Mail } from "lucide-react";
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
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Mail className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-medium text-ink">Email activity</h2>
            {enabled ? <Badge>On</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Keeps &ldquo;last spoken&rdquo; honest by reading who you exchanged mail with and
            when, so the follow-up queue stops chasing people you emailed last week.
          </p>
        </div>
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
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-3 text-sm text-muted-foreground">
          Connect Google above first — this reads the mailbox you connect there.
        </p>
      ) : !status.hasScope ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-3 text-sm text-muted-foreground">
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
