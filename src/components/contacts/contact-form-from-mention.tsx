"use client";

import { useRouter } from "next/navigation";
import { resolveUnresolvedMentionToContact } from "@/actions/unresolved-mentions";
import { ContactForm } from "@/components/contacts/contact-form";
import type { ContactInput } from "@/lib/contact-writes";
import { toast } from "@/lib/toast";

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
        resolveUnresolvedMentionToContact(mentionId, contact.id)
          .then((result) => {
            if (result?.alreadyResolved) {
              toast.message("This mention was already handled — the new contact was still created.");
            }
          })
          .catch(() => null);
        router.push(`/contacts/${contact.id}`);
      }}
    />
  );
}
