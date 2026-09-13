"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Undo2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { revertImportAction } from "@/actions/imports";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Undo, on the one write in this app large enough that a person cannot reasonably undo it
 * by hand.
 *
 * The dialog states the two things that make this honest rather than reassuring: what will
 * be removed, and what will deliberately NOT be — anyone the user has edited since is kept,
 * because an undo that destroys work done after the import is the same defect in the other
 * direction. The counts come from the import's own record, so the numbers shown are the
 * numbers that will actually be acted on.
 *
 * Confirmation is a plain two-button dialog rather than the admin `ConfirmActionDialog`:
 * this is the user's own data and there is no audit trail to justify, so demanding a typed
 * reason would be ceremony.
 */
export function ImportRevertButton({
  importId,
  fileName,
  contactsCreated,
  contactsUpdated,
}: {
  importId: string;
  fileName: string | null;
  contactsCreated: number;
  contactsUpdated: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function handleRevert() {
    setOpen(false);
    start(async () => {
      const result = await revertImportAction(importId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success("Import undone", { description: result.message });
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => setOpen(true)}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Undo2 className="size-3.5" />
        {pending ? "Undoing…" : "Undo"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Undo {fileName || "this import"}?</DialogTitle>
            <DialogDescription>
              This removes the {contactsCreated} contact
              {contactsCreated === 1 ? "" : "s"} this import added, along with the
              interactions and reminders it created
              {contactsUpdated > 0
                ? `, and rolls back the ${contactsUpdated} existing contact${
                    contactsUpdated === 1 ? "" : "s"
                  } it merged into`
                : ""}
              .
            </DialogDescription>
          </DialogHeader>

          {/* Outside the description on purpose: `DialogDescription` renders a <p>, and the
              accessible description should be the one-sentence summary, not both paragraphs
              read as one run-on. */}
          <p className="text-sm text-muted-foreground">
            Anyone you have edited since the import is left exactly as it is — undoing this
            will not overwrite work you did afterwards. You will be told how many were kept.
          </p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevert} disabled={pending}>
              <Undo2 className="size-3.5" />
              Undo import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
