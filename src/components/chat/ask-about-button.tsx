"use client";

import { MessageSquare } from "lucide-react";
import { useHiddenSurfaces } from "@/components/layout/hidden-surfaces";
import { buttonVariants } from "@/components/ui/button";
import { IntentLink } from "@/components/ui/intent-link";

/**
 * "Ask" on a contact's page: opens Chat with this person already attached, the way the
 * composer's `+` would. The name only labels the mention — the id is what reaches the model,
 * and `loadAttachedPeople` re-reads it scoped to the signed-in user.
 */
export function AskAboutButton({ contactId, name }: { contactId: string; name: string }) {
  const hidden = useHiddenSurfaces();
  if (hidden.has("page.chat")) return null;
  const href = `/chat?${new URLSearchParams({ contact: contactId, name })}`;
  return (
    <IntentLink href={href} className={buttonVariants({ variant: "outline", size: "sm" })}>
      <MessageSquare className="size-3.5" /> Ask
    </IntentLink>
  );
}
