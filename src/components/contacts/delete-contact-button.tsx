"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { deleteContact } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { CONTACT_DELETE_EXPLAINER } from "@/lib/contact-delete-copy";

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
          toast.error("Couldn’t delete that contact — try again?");
        }
      });
    }, 280);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={pending || leaving}
        className={cn(
          "delete-contact-btn group/trash text-destructive",
          "transition-[color,background-color,border-color,opacity,scale] duration-base",
          "hover:border-destructive/40 hover:bg-destructive/10",
          leaving && "pointer-events-none scale-95 opacity-0"
        )}
        onClick={() => setOpen(true)}
      >
        <Trash2
          className={cn(
            "size-3.5 transition-transform duration-base ease-out",
            "group-hover/trash:-translate-y-0.5 group-hover/trash:scale-110",
            "group-hover/trash:animate-[trash-wiggle_0.45s_ease-in-out]"
          )}
        />
        <span
          className={cn(
            "transition-[opacity,translate] duration-base",
            leaving && "translate-x-1 opacity-0"
          )}
        >
          {pending || leaving ? "Deleting…" : "Delete"}
        </span>
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="destructive"
        title={`Delete ${name ?? "this contact"}?`}
        description={CONTACT_DELETE_EXPLAINER}
        confirmLabel="Delete contact"
        pendingLabel="Deleting…"
        onConfirm={handleDelete}
      />
    </>
  );
}
