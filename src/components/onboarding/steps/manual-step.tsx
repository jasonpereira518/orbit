"use client";

import { ContactForm } from "@/components/contacts/contact-form";

export function ManualStep({ onCreated }: { onCreated: () => void }) {
  return <ContactForm redirectOnSuccess={false} onSuccess={() => onCreated()} />;
}
