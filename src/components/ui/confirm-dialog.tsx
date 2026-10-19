"use client";

import { useId, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";

/**
 * The one confirmation dialog.
 *
 * Six bespoke confirm dialogs and two `window.confirm` calls each chose their own title
 * shape, cancel style, error channel and button order. This fixes all four:
 *
 *   title       a question: "Delete this contact?"
 *   footer      Cancel (outline) on the left, the action on the right
 *   tone        "destructive" tints the action; "default" for a plain decision
 *   errors      inline `role="alert"` under the body; never a toast from here
 *   typed       `typedConfirmation="delete"` asks the user to type the word first
 *
 * `onConfirm` may be async; the dialog shows `pendingLabel` and closes when it resolves.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  tone = "default",
  typedConfirmation,
  onConfirm,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra body content between the description and the footer. */
  children?: ReactNode;
  confirmLabel: ReactNode;
  pendingLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: "default" | "destructive";
  /** The word the user must type before the action enables. */
  typedConfirmation?: string;
  onConfirm: () => Promise<unknown> | unknown;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const inputId = useId();

  // Reset for the next open while rendering, so a reopened dialog never flashes the
  // previous attempt's error or typed word (the "adjust state during render" pattern).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setPending(false);
      setError(null);
      setTyped("");
    }
  }

  const typedOk = !typedConfirmation || typed.trim().toLowerCase() === typedConfirmation.toLowerCase();

  async function confirm() {
    if (pending || !typedOk) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(friendlyError(err, "That didn’t work — try again?"));
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!pending ? onOpenChange(next) : undefined)}>
      <DialogContent className={cn("sm:max-w-md", className)} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className={tone === "destructive" ? "text-destructive" : undefined}>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {typedConfirmation && (
          <div className="space-y-2">
            <Label htmlFor={inputId}>
              Type <span className="font-mono font-medium text-ink">{typedConfirmation}</span> to continue
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void confirm();
                }
              }}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "destructive" ? "destructive" : "default"}
            onClick={() => void confirm()}
            disabled={pending || !typedOk}
          >
            {pending ? (pendingLabel ?? "Working…") : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
