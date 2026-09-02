"use client";

import { useRouter } from "next/navigation";
import { resolveUnresolvedMentionToContact } from "@/actions/unresolved-mentions";
import { ContactForm } from "@/components/contacts/contact-form";
import type { ContactInput } from "@/lib/contact-writes";

export function ContactFormFromMention({
  initial,
  mentionId,
}: {
  initial?: Partial<ContactInput> & { tags?: string[] };
  mentionId: string;
}) {
  const router = useRouter();
  return (
    <ContactForm
      initial={initial}
      redirectOnSuccess={false}
      onSuccess={(contact) => {
        resolveUnresolvedMentionToContact(mentionId, contact.id).catch(() => null);
        router.push(`/contacts/${contact.id}`);
      }}
    />
  );
}
