"use client";

import { Bell, Calendar, Check, Loader2, NotebookPen, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { commitProposedAction, dismissProposedAction } from "@/actions/chat-actions";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { Button } from "@/components/ui/button";
import type { StoredProposedAction } from "@/lib/chat-proposed-actions";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ICON: Record<StoredProposedAction["args"]["kind"], typeof NotebookPen> = {
  log_interaction: NotebookPen,
  create_reminder: Bell,
  schedule_follow_up: Calendar,
};

const RESULT_HREF: Record<StoredProposedAction["args"]["kind"], (resultId: string) => string | null> = {
  log_interaction: () => null,
  create_reminder: () => "/reminders",
  schedule_follow_up: () => "/reminders",
};

/**
 * A card per action a chat answer proposed — log a note, set a reminder, schedule a
 * follow-up — with the exact text that will be written and a due date in plain language.
 * Confirm is the only path to the real write; Dismiss and a reload both leave it untouched.
 *
 * Local `phase` covers the click-to-response gap; what actually persists is the row's own
 * `status`, passed back in from the server on both success and failure, so a reload always
 * shows the true state rather than this component's guess at it.
 */
export function ProposedActionsCard({
  messageId,
  action,
  contactName,
  onSettled,
}: {
  messageId: string;
  action: StoredProposedAction;
  /** From `chat-panel`'s own retrieval-grounded map — absent for an action naming nobody. */
  contactName?: string | null;
  onSettled: (next: StoredProposedAction) => void;
}) {
  const [busy, setBusy] = useState(false);
  const Icon = ICON[action.args.kind];
  const contactId = "contactId" in action.args ? action.args.contactId : null;

  async function confirm() {
    if (busy || action.status !== "proposed") return;
    setBusy(true);
    try {
      const res = await commitProposedAction(messageId, action.id);
      if (res.ok) {
        onSettled({ ...action, status: "done", resultId: res.resultId ?? null });
      } else {
        toast.error(res.reason);
        onSettled({ ...action, status: "proposed" });
      }
    } catch {
      toast.error("Couldn’t do that — try again?");
      onSettled({ ...action, status: "proposed" });
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (busy || action.status !== "proposed") return;
    setBusy(true);
    try {
      const res = await dismissProposedAction(messageId, action.id);
      if (res.ok) onSettled({ ...action, status: "dismissed" });
      else toast.error(res.reason);
    } catch {
      toast.error("Couldn’t dismiss that — try again?");
    } finally {
      setBusy(false);
    }
  }

  const resultHref = action.resultId ? RESULT_HREF[action.args.kind](action.resultId) : null;

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-background p-3">
      {contactId ? (
        <ContactAvatar
          contactId={contactId}
          fullName={contactName ?? ""}
          profileImageUrl={null}
          size="sm"
          className="size-8 shrink-0"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-snug text-foreground">{action.preview}</p>
        <div className="mt-2 flex items-center gap-2">
          {action.status === "proposed" && (
            <>
              <Button type="button" size="sm" onClick={confirm} disabled={busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                Confirm
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={dismiss} disabled={busy}>
                <X className="size-3.5" aria-hidden />
                Dismiss
              </Button>
            </>
          )}
          {action.status === "committing" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Adding…
            </span>
          )}
          {action.status === "done" && (
            <span className={cn("flex items-center gap-1.5 text-xs text-muted-foreground")}>
              <Check className="size-3.5 text-primary" aria-hidden />
              Added
              {resultHref && (
                <>
                  {" · "}
                  <Link href={resultHref} className="text-primary underline underline-offset-2">
                    View
                  </Link>
                </>
              )}
            </span>
          )}
          {action.status === "dismissed" && (
            <span className="text-xs text-muted-foreground">Dismissed</span>
          )}
        </div>
      </div>
    </div>
  );
}
