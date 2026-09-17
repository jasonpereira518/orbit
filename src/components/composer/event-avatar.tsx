"use client";

/**
 * The row glyph for a past meeting: whose meeting it was, and what kind.
 *
 * A face is how you pick the right meeting out of a list — you recognise the person long
 * before you read the date. But the `@` type-ahead interleaves people and meetings in one
 * list, so a bare face would make a meeting row indistinguishable from a person row apart
 * from the `— in person` suffix in its title. The badge carries that distinction, and it
 * carries more than the calendar icon it replaces: it is `interactionTypeIcon`, the same
 * glyph the contact timeline and the suggestion pills use, so a coffee looks like a coffee
 * everywhere in the app.
 *
 * Shared by the `+` menu and the `@` list rather than written twice — this feature has
 * already produced one drifted duplicate, in the four suggestion chips that lived verbatim
 * in both the chat panel and the ask bar.
 */

import { createElement } from "react";

import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { interactionTypeIcon, interactionTypeLabel } from "@/lib/interaction-types";
import { cn } from "@/lib/utils";

export function EventAvatar({
  contactId,
  contactName,
  contactFirstName,
  avatarUrl,
  interactionType,
  className,
}: {
  contactId: string;
  contactName: string;
  contactFirstName: string | null;
  avatarUrl: string | null;
  interactionType: string;
  className?: string;
}) {
  return (
    <span className={cn("relative shrink-0", className)}>
      <ContactAvatar
        contactId={contactId}
        firstName={contactFirstName}
        fullName={contactName}
        profileImageUrl={avatarUrl}
        size="sm"
        className="size-7"
      />
      {/* `bg-popover`, not `bg-card`: both surfaces that render this are popovers, and it is
          the token that follows them into dark mode. The ring is what separates the badge
          from a photo it happens to sit on. */}
      <span
        className="absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-popover ring-1 ring-border/70"
        // The type is already in the row's title as words; this is the glanceable twin, so
        // it needs no second announcement.
        aria-hidden
        title={interactionTypeLabel(interactionType)}
      >
        {/* `createElement` rather than binding `const Icon = …` and writing `<Icon />`:
            the compiler's lint reads any capitalised binding assigned during render as a
            component being created there, and flags it wherever it sits — inside an IIFE
            too. There is no component being created here, only one being chosen. */}
        {createElement(interactionTypeIcon(interactionType), {
          className: "size-2.5 text-muted-foreground",
        })}
      </span>
    </span>
  );
}
