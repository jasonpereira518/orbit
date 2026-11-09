"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { TaskSheetHeader } from "@/components/ui/task-sheet-header";
import { ContactForm } from "@/components/contacts/contact-form";
import { DeleteContactButton } from "@/components/contacts/delete-contact-button";
import { MergeContactButton } from "@/components/contacts/merge-contact-button";
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
          showCloseButton={false}
          className="w-full overflow-y-auto max-sm:!inset-0 max-sm:!w-full max-sm:!rounded-none sm:max-w-lg"
        >
          <TaskSheetHeader title={`Edit ${name}`} description="Update profile details, strength, tags, and notes." onClose={() => setOpen(false)} />
          <div className="flex flex-col gap-6 px-4 pb-6">
            <ContactForm
              contactId={contactId}
              initial={initial}
              className="rounded-none border-0 bg-transparent p-0 shadow-none"
              onSuccess={() => setOpen(false)}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
              <MergeContactButton id={contactId} name={name} />
              <DeleteContactButton id={contactId} name={name} />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
