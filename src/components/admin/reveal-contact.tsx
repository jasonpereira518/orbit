"use client";

import { useState, useTransition } from "react";
import { Eye } from "lucide-react";
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
import { revealContactAction, type RevealedContact } from "@/actions/admin";
import { toast } from "@/lib/toast";

/**
 * The deliberate escape hatch in an otherwise metadata-only console.
 *
 * There will eventually be a ticket that genuinely needs a real record ("the import
 * mangled row 340"), so rather than pretend otherwise there is exactly one door — and it
 * is instrumented. Reveals one record, for one page view. No "reveal all" toggle, no
 * session-wide unmasking.
 *
 * The reason is typed rather than picked from a dropdown on purpose: typing creates a
 * moment of deliberation, and it makes the audit row worth reading later.
 */
export function RevealContactButton({
  targetUserId,
  contactId,
}: {
  targetUserId: string;
  contactId: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [revealed, setRevealed] = useState<RevealedContact | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    startTransition(async () => {
      try {
        const result = await revealContactAction({
          targetUserId,
          contactId,
          reason,
        });
        setRevealed(result);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not reveal that record."
        );
      }
    });
  };

  const close = () => {
    setOpen(false);
    // Never persist a revealed record past the dialog.
    setRevealed(null);
    setReason("");
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Reveal this record"
        onClick={() => setOpen(true)}
      >
        <Eye className="size-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-md">
          {revealed ? (
            <>
              <DialogHeader>
                <DialogTitle>{revealed.fullName}</DialogTitle>
                <DialogDescription>
                  This access has been logged to the audit trail.
                </DialogDescription>
              </DialogHeader>
              <dl className="space-y-1.5 text-sm">
                <Row label="Email">{revealed.email ?? "—"}</Row>
                <Row label="Phone">{revealed.phone ?? "—"}</Row>
                <Row label="Company">{revealed.company ?? "—"}</Row>
                <Row label="Title">{revealed.title ?? "—"}</Row>
                <Row label="Notes">
                  {revealed.notes ? (
                    <span className="whitespace-pre-wrap">{revealed.notes}</span>
                  ) : (
                    "—"
                  )}
                </Row>
              </dl>
              <DialogFooter>
                <Button onClick={close}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Reveal this record?</DialogTitle>
                <DialogDescription>
                  This shows one contact&apos;s real name, contact details and the
                  user&apos;s private notes about them. The access is recorded in the audit
                  trail with your reason.
                </DialogDescription>
              </DialogHeader>

              <div>
                <label
                  htmlFor="reveal-reason"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Why do you need to see it?
                </label>
                <Input
                  id="reveal-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Debugging duplicate rows from their LinkedIn import"
                  className="mt-1"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && reason.trim().length >= 4) submit();
                  }}
                />
              </div>

              <DialogFooter>
                <Button variant="ghost" onClick={close} disabled={pending}>
                  Cancel
                </Button>
                <Button
                  onClick={submit}
                  disabled={pending || reason.trim().length < 4}
                >
                  {pending ? "Revealing…" : "Reveal and log"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-border/40 py-1 last:border-b-0">
      <dt className="w-20 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}
