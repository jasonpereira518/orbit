"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";

export function DeleteContactButton({
  id,
  name,
}: {
  id: string;
  name?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [pending, start] = useTransition();

  function handleDelete() {
    setOpen(false);
    setLeaving(true);

    window.setTimeout(() => {
      start(async () => {
        try {
          await deleteContact(id);
          toast.success(
            name ? `${name} deleted` : "Contact deleted"
          );
          router.push("/contacts");
          router.refresh();
        } catch {
          setLeaving(false);
          toast.error("Could not delete contact");
        }
      });
    }, 280);
  }

  return (
    <>
      <Button
        variant="outline"
        disabled={pending || leaving}
        className={cn(
          "delete-contact-btn group/trash text-destructive",
          "transition-all duration-300",
          "hover:border-destructive/40 hover:bg-destructive/10",
          leaving && "pointer-events-none scale-95 opacity-0"
        )}
        onClick={() => setOpen(true)}
      >
        <Trash2
          className={cn(
            "size-3.5 transition-transform duration-300 ease-out",
            "group-hover/trash:-translate-y-0.5 group-hover/trash:scale-110",
            "group-hover/trash:animate-[trash-wiggle_0.45s_ease-in-out]"
          )}
        />
        <span
          className={cn(
            "transition-all duration-300",
            leaving && "translate-x-1 opacity-0"
          )}
        >
          {pending || leaving ? "Deleting…" : "Delete"}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {name ?? "this contact"}?
            </DialogTitle>
            <DialogDescription>
              This removes the contact and their interaction history. This
              cannot be undone.
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
