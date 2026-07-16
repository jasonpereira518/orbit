"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { deleteContact } from "@/actions/contacts";
import { Button } from "@/components/ui/button";

export function DeleteContactButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      variant="outline"
      disabled={pending}
      className="text-destructive"
      onClick={() => {
        if (!confirm("Delete this contact and their history?")) return;
        start(async () => {
          await deleteContact(id);
          toast.success("Contact deleted");
          router.push("/contacts");
          router.refresh();
        });
      }}
    >
      Delete
    </Button>
  );
}
