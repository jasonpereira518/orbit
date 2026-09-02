"use client";

import { MailX, Trash2, Undo2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import {
  deleteInterestListAction,
  resubscribeInterestListAction,
  unsubscribeInterestListAction,
} from "@/actions/admin";

/**
 * Per-row removal controls.
 *
 * Two operations, kept visibly unequal. Unsubscribe is the everyday one and reads as
 * ordinary; delete is the destructive one and is styled, worded and gated as such — it
 * demands the address be typed back, because the thing most likely to go wrong here is
 * removing the row above or below the one you meant.
 *
 * Each dialog names the consequence rather than the mechanism, matching `AccountDangerZone`:
 * what matters to the operator is "they stop getting mail but you keep the record" versus
 * "the signup date and source are gone", not which column moved.
 */

const BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-xs transition-colors duration-fast";

export function InterestListRowActions({
  id,
  email,
  unsubscribed,
}: {
  id: string;
  email: string;
  unsubscribed: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {unsubscribed ? (
        <ConfirmActionDialog
          trigger={
            <span
              className={`${BUTTON} text-muted-foreground hover:border-border hover:text-foreground`}
            >
              <Undo2 className="size-3" aria-hidden />
              Restore
            </span>
          }
          title="Put them back on the list?"
          description={
            <>
              <span className="font-medium text-ink">{email}</span> becomes mailable again
              and is re-armed for the day-3 follow-up. Use this if the wrong row was
              removed — not to override someone who unsubscribed themselves.
            </>
          }
          confirmLabel="Restore"
          onConfirm={(reason) => resubscribeInterestListAction({ id, reason })}
        />
      ) : (
        <ConfirmActionDialog
          trigger={
            <span
              className={`${BUTTON} text-muted-foreground hover:border-border hover:text-foreground`}
            >
              <MailX className="size-3" aria-hidden />
              Unsubscribe
            </span>
          }
          title="Stop mailing this address?"
          description={
            <>
              <span className="font-medium text-ink">{email}</span> stops receiving anything
              immediately, including the day-3 follow-up. The row stays, so you keep their
              signup date and source — and you can undo this from the same table.
            </>
          }
          confirmLabel="Unsubscribe"
          onConfirm={(reason) => unsubscribeInterestListAction({ id, reason })}
        />
      )}

      <ConfirmActionDialog
        trigger={
          <span
            className={`${BUTTON} border-destructive/40 text-destructive hover:bg-destructive/10`}
          >
            <Trash2 className="size-3" aria-hidden />
            Delete
          </span>
        }
        title="Delete this signup entirely?"
        description={
          <>
            The row for <span className="font-medium text-ink">{email}</span> is erased. Their
            signup date and source are lost, and if that address joins again it is treated as
            brand new. To simply stop mailing them, use Unsubscribe instead — it keeps the
            record.
          </>
        }
        confirmLabel="Delete permanently"
        danger
        typedConfirmation={email}
        typedConfirmationHint="Type the address to confirm"
        onConfirm={(reason) =>
          deleteInterestListAction({ id, confirmEmail: email, reason })
        }
      />
    </div>
  );
}
