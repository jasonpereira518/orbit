"use client";

import { useState } from "react";
import { ContactFollowUpSection } from "@/components/contacts/contact-follow-up-section";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ContactFollowUpSendOptions } from "@/actions/contacts";

export function ContactRelatedReachOut({
  contactId,
  contactName,
  subjectName,
  email,
  linkedinUrl,
  phone,
}: {
  contactId: string;
  contactName: string;
  subjectName: string;
  email?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
}) {
  const [open, setOpen] = useState(false);

  const sendOptions: ContactFollowUpSendOptions = {
    hasEmail: Boolean(email?.trim()),
    hasLinkedIn: Boolean(linkedinUrl?.trim()),
    email: email?.trim() || null,
    linkedinUrl: linkedinUrl?.trim() || null,
    canSendEmail: false,
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0"
        onClick={() => setOpen(true)}
      >
        Reach out
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Reach out to {contactName}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            <ContactFollowUpSection
              contactId={contactId}
              contactName={contactName}
              sendOptions={sendOptions}
              phone={phone}
              initialIntent={`Ask ${contactName} for an intro or insight related to ${subjectName}`}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
