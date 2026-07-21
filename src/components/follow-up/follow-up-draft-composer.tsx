"use client";

import { Copy, ExternalLink, Mail } from "lucide-react";
import type { ContactFollowUpSendOptions } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function FollowUpDraftComposer({
  contactName,
  draft,
  onDraftChange,
  sendOptions,
  pending,
  sending,
  marking,
  onCopy,
  onSendEmail,
  onMarkSent,
  onOpenLinkedIn,
  emptyHint,
}: {
  contactName: string;
  draft: string;
  onDraftChange: (value: string) => void;
  sendOptions: ContactFollowUpSendOptions | null;
  pending?: boolean;
  sending?: boolean;
  marking?: boolean;
  onCopy: () => void;
  onSendEmail: () => void;
  onMarkSent: (channel: "email" | "linkedin_message" | "note") => void;
  onOpenLinkedIn: (url: string) => void;
  emptyHint?: string;
}) {
  const hint = !sendOptions
    ? "Loading send options…"
    : sendOptions.canSendEmail
      ? "You can send this by email with one click."
      : sendOptions.hasLinkedIn
        ? "LinkedIn can’t be sent automatically — copy, open their profile, then mark sent."
        : sendOptions.hasEmail
          ? "Add a Resend API key in Settings to send email from Orbit — or copy and mark sent."
          : "Add an email or LinkedIn URL to send or open a follow-up.";

  const markChannel: "email" | "linkedin_message" | "note" = sendOptions?.canSendEmail
    ? "email"
    : sendOptions?.hasLinkedIn
      ? "linkedin_message"
      : sendOptions?.hasEmail
        ? "email"
        : "note";

  if (!draft) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{hint}</p>
        <p className="text-sm text-muted-foreground">
          {pending
            ? "Drafting a follow-up…"
            : emptyHint ||
              `Generate a warm follow-up grounded in your history with ${contactName}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Textarea
        rows={8}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        className="resize-y text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCopy}>
          <Copy className="size-3.5" />
          Copy
        </Button>
        {sendOptions?.canSendEmail ? (
          <Button
            type="button"
            size="sm"
            disabled={sending || marking || !draft.trim()}
            onClick={onSendEmail}
          >
            <Mail className="size-3.5" />
            {sending ? "Sending…" : "Send email"}
          </Button>
        ) : null}
        {sendOptions?.hasLinkedIn && sendOptions.linkedinUrl ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenLinkedIn(sendOptions.linkedinUrl!)}
          >
            <ExternalLink className="size-3.5" />
            Open LinkedIn
          </Button>
        ) : null}
        <Button
          type="button"
          variant={sendOptions?.canSendEmail ? "ghost" : "default"}
          size="sm"
          disabled={sending || marking}
          onClick={() => onMarkSent(markChannel)}
        >
          {marking ? "Saving…" : "Mark sent"}
        </Button>
      </div>
    </div>
  );
}
