"use client";

import { cancelEmailSendAction } from "@/actions/email-sends";
import { UNDO_DELAY_MS } from "@/lib/email/config";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * "Sending to Maya… Undo". The email is already queued with send_at = now + 10s; Undo cancels
 * it if the dispatcher hasn't claimed it yet. The toast lives exactly as long as the window,
 * and is not kept in the notification panel: an Undo offered after the mail left would lie.
 */
export function showUndoSendToast(opts: { sendId: string; recipientLabel: string; onUndone?: () => void }) {
  const id = toast.message(`Sending to ${opts.recipientLabel}…`, {
    duration: UNDO_DELAY_MS,
    keep: false,
    action: {
      label: "Undo",
      onClick: async () => {
        try {
          const { result } = await cancelEmailSendAction(opts.sendId);
          if (result === "canceled") {
            toast.success("Send canceled — nothing went out", { id });
            opts.onUndone?.();
          } else {
            toast.message("Already sent", { id });
          }
        } catch (err) {
          toast.error(friendlyError(err, "Couldn’t undo that — it may already be on its way"), { id, keep: false });
        }
      },
    },
  });
}
