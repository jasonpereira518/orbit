"use client";

import { Copy, ExternalLink, Mail } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ContactFollowUpSendOptions } from "@/actions/contacts";
import { ConnectMailboxButton } from "@/components/email/connect-mailbox-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

/**
 * The one-line hint above the draft. Until the send options arrive it is a placeholder bar of
 * the same line height (`text-xs` = 16px), with the old words kept for screen readers.
 */
function SendHint({
  hint,
  loading,
  sendOptions,
}: {
  hint: string;
  loading: boolean;
  sendOptions?: ContactFollowUpSendOptions | null;
}) {
  const pathname = usePathname();
  const block = sendOptions?.hasEmail ? sendOptions.sendBlock : null;
  if (!loading) {
    if (!block || block === "cap_reached") return <p className="text-xs text-muted-foreground">{hint}</p>;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">{hint}</p>
        <ConnectMailboxButton reason={block} returnTo={pathname || "/contacts"} />
      </div>
    );
  }
  return (
    <div className="flex h-4 items-center">
      <Skeleton className="h-3 w-56 max-w-full" />
      <span role="status" aria-live="polite" className="sr-only">
        {hint}
      </span>
    </div>
  );
}

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
      ? "You can send this from your own email with one click."
      : sendOptions.hasEmail && sendOptions.sendBlock === "cap_reached"
        ? "You’ve reached today’s email limit — copy and mark sent."
        : sendOptions.hasEmail && sendOptions.sendBlock
          ? "Connect Gmail to send this from your own address — or copy and mark sent."
          : sendOptions.hasLinkedIn
            ? "LinkedIn can’t be sent automatically — copy, open their profile, then mark sent."
            : sendOptions.hasEmail
              ? "Copy it into your email, then mark sent."
              : "Add an email or LinkedIn URL to send or open a follow-up.";

  const markChannel: "email" | "linkedin_message" | "note" = sendOptions?.canSendEmail
    ? "email"
    : sendOptions?.hasLinkedIn
      ? "linkedin_message"
      : sendOptions?.hasEmail
        ? "email"
        : "note";

  if (!draft && pending) {
    // The draft is being written: the shape it will land in — the text box and the row of
    // actions under it — rather than a line of text the box then pushes aside.
    return (
      <div className="space-y-3">
        <SendHint hint={hint} loading={!sendOptions} sendOptions={sendOptions} />
        <div className="space-y-2 rounded-lg border border-input px-2.5 py-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3.5 w-1/3" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-7 w-20 rounded-lg" />
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          Drafting a follow-up…
        </span>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="space-y-2">
        <SendHint hint={hint} loading={!sendOptions} sendOptions={sendOptions} />
        <p className="text-sm text-muted-foreground">
          {emptyHint ||
            `Generate a warm follow-up grounded in your history with ${contactName}.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SendHint hint={hint} loading={!sendOptions} sendOptions={sendOptions} />
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
