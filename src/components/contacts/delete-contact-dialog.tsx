"use client";

import { useRouter } from "next/navigation";
import { useGuardedTransition } from "@/lib/single-flight";
import { Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { deleteContact } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CONTACT_DELETE_EXPLAINER } from "@/lib/contact-delete-copy";

/**
 * "Delete {name}?" — the confirm dialog, opened by the edit sheet's ⋯ menu. Controlled, with
 * no trigger of its own, so the menu item that opens it can close without unmounting it.
 */
export function DeleteContactDialog({
  id,
  name,
  open,
  onOpenChange,
}: {
  id: string;
  name?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useGuardedTransition();
  const setOpen = onOpenChange;

  function handleDelete() {
    start(async () => {
      try {
        await deleteContact(id);
        setOpen(false);
        toast.success(name ? `${name} deleted` : "Contact deleted");
        router.push("/contacts");
        router.refresh();
      } catch {
        toast.error("Couldn’t delete that contact — try again?");
      }
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {name ?? "this contact"}?
            </DialogTitle>
            <DialogDescription>
              {CONTACT_DELETE_EXPLAINER}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="delete-confirm-btn"
              onClick={handleDelete}
              disabled={pending}
            >
              <Trash2 className="size-3.5" />
              Delete contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
