"use client";

import { useRef, useState } from "react";
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
import { friendlyError } from "@/lib/errors";

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
 *
 * Pending state is a real `useState` flag, not `useTransition`. React 19's transitions stop
 * reporting pending as soon as the async body hits its first `await`, which left Confirm
 * re-enabled and Escape/backdrop free to `reset()` mid-flight — so a waitlist Remove or
 * Delete could finish on the server while the UI looked cancelled and never refreshed.
 * Same closed doors as `AddEmailDialog`: `disablePointerDismissal` for the backdrop, and
 * `onOpenChange` refusing a close while `pending` for Escape and the header X. `runRef`
 * drops late continuations after a reset so a stale success toast cannot fire for a dialog
 * that is no longer on screen.
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
  const [pending, setPending] = useState(false);
  // Bumped on every reset — a run started before the bump checks this after its await
  // and drops itself if it no longer matches.
  const runRef = useRef(0);

  const reasonOk = reason.trim().length >= minReason;
  const typedOk =
    !typedConfirmation ||
    typed.trim().toLowerCase() === typedConfirmation.trim().toLowerCase();
  const ready = reasonOk && typedOk && !pending;

  const reset = () => {
    runRef.current += 1;
    setReason("");
    setTyped("");
    setPending(false);
  };

  const submit = async () => {
    if (!ready) return;
    const runId = runRef.current;
    setPending(true);
    try {
      await onConfirm(reason.trim());
      if (runId !== runRef.current) return;
      toast.success(`${confirmLabel} — done`);
      setOpen(false);
      reset();
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch (e) {
      if (runId !== runRef.current) return;
      // Surfaced verbatim when the server threw UserFacingError (guard messages like
      // "That signup no longer exists"); otherwise the generic fallback.
      toast.error(friendlyError(e, "That didn’t work — try again?"));
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(next) => {
        // Escape and the header X reach here even with the backdrop blocked — refuse a
        // close while the action is in flight so reset() cannot run under it.
        if (!next && pending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>

      <DialogContent className="sm:max-w-md" showCloseButton={!pending}>
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
              disabled={pending}
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
                disabled={pending}
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
