"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * One dialog for every operator write.
 *
 * Routing all of them through a single component is what makes "confirm, give a reason, get
 * an audit row" impossible to forget when the next action is added — the reason field is not
 * optional here, and the server rejects a short one regardless.
 *
 * `typedConfirmation` is for the irreversible ones. It is not ceremony: the roster is a list
 * of near-identical rows, and the failure this guards against is acting on the account next
 * to the one you meant.
 */
export function ConfirmActionDialog({
  trigger,
  title,
  description,
  confirmLabel,
  danger,
  minReason = 4,
  typedConfirmation,
  typedConfirmationHint,
  redirectTo,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  minReason?: number;
  /** When set, must be typed verbatim (case-insensitively) before the button enables. */
  typedConfirmation?: string;
  typedConfirmationHint?: string;
  /** When set, navigate here on success instead of refreshing the current page — for
   * actions (like a hard delete) after which the current page no longer exists. */
  redirectTo?: string;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();

  const reasonOk = reason.trim().length >= minReason;
  const typedOk =
    !typedConfirmation ||
    typed.trim().toLowerCase() === typedConfirmation.trim().toLowerCase();
  const ready = reasonOk && typedOk && !pending;

  const reset = () => {
    setReason("");
    setTyped("");
  };

  const submit = () => {
    if (!ready) return;
    startTransition(async () => {
      try {
        await onConfirm(reason.trim());
        toast.success(`${confirmLabel} — done.`);
        setOpen(false);
        reset();
        if (redirectTo) {
          router.push(redirectTo);
        } else {
          router.refresh();
        }
      } catch (e) {
        // Surfaced verbatim: these are the server's own guard messages ("Refusing to act on
        // your own account"), and paraphrasing them would hide which guard fired.
        toast.error(e instanceof Error ? e.message : "That didn't work.");
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className={cn(danger && "text-destructive")}>
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium">Reason</span>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="What prompted this? Goes in the audit log."
              className="text-sm"
            />
          </label>

          {typedConfirmation && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">
                {typedConfirmationHint ?? `Type ${typedConfirmation} to confirm`}
              </span>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={typedConfirmation}
                className="h-8 text-sm"
                autoComplete="off"
              />
            </label>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
            size="sm"
          >
            Cancel
          </Button>
          <Button
            variant={danger ? "destructive" : "default"}
            onClick={submit}
            disabled={!ready}
            size="sm"
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
