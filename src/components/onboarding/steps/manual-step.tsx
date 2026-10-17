"use client";

import { ContactForm } from "@/components/contacts/contact-form";

/** Someone by hand: who they are, how you met, and when to follow up (a week out by default). */
export function ManualStep({ onCreated }: { onCreated: () => void }) {
  return (
    <ContactForm compact followUpChoice submitLabel="Add them" redirectOnSuccess={false} onSuccess={() => onCreated()} />
  );
}
