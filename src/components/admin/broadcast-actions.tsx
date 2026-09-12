"use client";

import { Eye, Send, Trash2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import { deleteBroadcastAction, sendBroadcastAction } from "@/actions/admin";

/**
 * Send / delete controls for one broadcast row.
 *
 * The send demands the subject be typed back. Every other typed confirmation in this console
 * guards one account; this one guards an irreversible mail to the entire list, which is the
 * only action here that reaches hundreds of strangers at once.
 */
const BUTTON =
  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors duration-fast";

export function BroadcastRowActions({
  id,
  subject,
  status,
  audienceSize,
  remaining,
}: {
  id: string;
  subject: string;
  status: "draft" | "sending" | "sent";
  audienceSize: number;
  remaining: number;
}) {
  const sendable = status !== "sent";
  // A resumed send addresses only who is left, not the whole audience again.
  const target = status === "sending" ? remaining : audienceSize;

  return (
    <div className="flex items-center justify-end gap-1.5">
      <a
        href={`/api/admin/email-preview?template=broadcast&id=${id}`}
        target="_blank"
        rel="noreferrer"
        className={`${BUTTON} border-border/70 text-muted-foreground hover:text-foreground`}
      >
        <Eye className="size-3" aria-hidden />
        Preview
      </a>

      {sendable && (
        <ConfirmActionDialog
          trigger={
            <span className={`${BUTTON} border-accent/40 text-accent-foreground hover:bg-accent/10`}>
              <Send className="size-3" aria-hidden />
              {status === "sending" ? `Resume (${remaining})` : `Send to ${target}`}
            </span>
          }
          title={
            status === "sending"
              ? `Resume this send to ${remaining} remaining?`
              : `Send to ${target} ${target === 1 ? "person" : "people"}?`
          }
          description={
            <>
              This mails <span className="font-medium text-ink">{subject}</span> to every
              active subscriber — everyone who has not unsubscribed and does not already have
              an account. It cannot be recalled. Send yourself a test first if you have not.
            </>
          }
          confirmLabel={status === "sending" ? "Resume send" : "Send now"}
          danger
          typedConfirmation={subject}
          typedConfirmationHint="Type the subject to confirm"
          onConfirm={(reason) =>
            sendBroadcastAction({ id, confirmSubject: subject, reason })
          }
        />
      )}

      {status === "draft" && (
        <ConfirmActionDialog
          trigger={
            <span className={`${BUTTON} border-destructive/40 text-destructive hover:bg-destructive/10`}>
              <Trash2 className="size-3" aria-hidden />
              Delete
            </span>
          }
          title="Delete this draft?"
          description="Nothing has been sent, so this only discards the text."
          confirmLabel="Delete draft"
          onConfirm={(reason) => deleteBroadcastAction({ id, reason })}
        />
      )}
    </div>
  );
}
