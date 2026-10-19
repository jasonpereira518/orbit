"use client";

import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DAILY_SEND_LIMIT } from "@/lib/outreach-types";

/**
 * The "really send this?" step before Orbit sends on the person's behalf.
 *
 * A `ConfirmDialog` in its destructive tone: `onConfirm` may be async, the dialog shows
 * "Sending…" until it settles and stays open with the error inline when it throws (a
 * `UserFacingError` carries the server's own message through `friendlyError`).
 */
export function DangerSendDialog({
  open,
  onOpenChange,
  recipientCount,
  channel,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientCount: number;
  channel: string;
  onConfirm: () => Promise<unknown> | unknown;
  /** Extra context under the warning — a quality note, say. */
  children?: ReactNode;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="destructive"
      title={`Send ${recipientCount} message${recipientCount === 1 ? "" : "s"}?`}
      description={
        <span className="block space-y-2 pt-1">
          <span className="block">
            You are about to automatically send via <strong>{channel}</strong>. This cannot
            be undone and may affect your sender reputation.
          </span>
          <span className="block text-destructive">
            Only send to people you have a legitimate reason to contact. Respect opt-outs
            and platform rules.
          </span>
          <span className="block">Daily limit: {DAILY_SEND_LIMIT} messages per user.</span>
        </span>
      }
      confirmLabel="Send now"
      pendingLabel="Sending…"
      onConfirm={onConfirm}
    >
      {children}
    </ConfirmDialog>
  );
}
