"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ContactForm } from "@/components/contacts/contact-form";
import { DeleteContactButton } from "@/components/contacts/delete-contact-button";
import type { ContactInput } from "@/actions/contacts";

export function ContactEditSheet({
  contactId,
  name,
  initial,
}: {
  contactId: string;
  name: string;
  initial: Partial<ContactInput> & { tags?: string[]; tagNames?: string[] };
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-3.5" />
        Edit
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-lg"
        >
          <SheetHeader>
            <SheetTitle>Edit {name}</SheetTitle>
            <SheetDescription>
              Update profile details, closeness, tags, and notes.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-6 px-4 pb-6">
            <ContactForm
              contactId={contactId}
              initial={initial}
              className="rounded-none border-0 bg-transparent p-0 shadow-none"
              onSuccess={() => setOpen(false)}
            />
            <div className="border-t border-border/60 pt-4">
              <DeleteContactButton id={contactId} name={name} />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
