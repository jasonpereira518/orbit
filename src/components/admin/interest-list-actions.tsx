"use client";

import { useTransition } from "react";
import { MailX, Send, Trash2, Undo2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import {
  deleteInterestListAction,
  inviteToSiteAction,
  resubscribeInterestListAction,
  unsubscribeInterestListAction,
} from "@/actions/admin";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

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

/**
 * Let one person in: a Clerk invitation, emailed by Clerk, that creates an account even while
 * the site is in stealth. No confirm dialog — it grants one address one link, is revocable
 * from /admin/access, and is audited there like every other invitation.
 */
function InviteButton({ email }: { email: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            const res = await inviteToSiteAction({ email, notify: true });
            if (res.kind === "error") toast.error(res.message);
            else if (res.kind === "existing-account") toast.success("They already have an account — it’s let in now");
            else toast.success(`Invitation sent to ${email}`);
          } catch (err) {
            toast.error(friendlyError(err, "Couldn’t send that invitation — try again?"));
          }
        })
      }
      className={`${BUTTON} border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-60`}
    >
      <Send className="size-3" aria-hidden />
      {pending ? "Inviting…" : "Invite"}
    </button>
  );
}

export function InterestListRowActions({
  id,
  email,
  unsubscribed,
  invitable = false,
}: {
  id: string;
  email: string;
  unsubscribed: boolean;
  invitable?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {invitable && <InviteButton email={email} />}
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
          title="Put them back on the waitlist?"
          description={
            <>
              <span className="font-medium text-ink">{email}</span> goes back to their old
              place in line and becomes mailable again. Use this if the wrong row was
              removed — not to override someone who left themselves.
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
              Remove
            </span>
          }
          title="Take this address off the waitlist?"
          description={
            <>
              <span className="font-medium text-ink">{email}</span> leaves the line and stops
              receiving anything immediately. The row stays, so you keep their signup date
              and source — and you can undo this from the same table.
            </>
          }
          confirmLabel="Remove from line"
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
