"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DAILY_SEND_LIMIT } from "@/lib/outreach-types";

export function DangerSendDialog({
  open,
  onOpenChange,
  recipientCount,
  channel,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientCount: number;
  channel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send {recipientCount} message{recipientCount === 1 ? "" : "s"}?</DialogTitle>
          <DialogDescription className="space-y-2 pt-1">
            <span className="block">
              You are about to automatically send via <strong>{channel}</strong>.
              This cannot be undone and may affect your sender reputation.
            </span>
            <span className="block text-destructive">
              Only send to people you have a legitimate reason to contact. Respect
              opt-outs and platform rules.
            </span>
            <span className="block">
              Daily limit: {DAILY_SEND_LIMIT} messages per user.
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Sending…" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
