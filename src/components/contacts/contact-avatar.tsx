"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  isUnusableAvatarUrl,
  resolveContactPhotoUrl,
} from "@/lib/contact-avatar-url";
import {
  genderAvatarSrc,
  guessGenderFromFirstName,
} from "@/lib/guess-gender";
import { cn } from "@/lib/utils";

export function ContactAvatar({
  contactId,
  firstName,
  fullName,
  profileImageUrl,
  size = "lg",
  className,
  /**
   * When true and there is no stored photo, hit the avatar API so the view can
   * resolve + persist on demand.
   *
   * The route tries every free source (Unavatar, then Gravatar by email, then
   * Microlink) — not just LinkedIn — so callers gate this on whether the contact
   * has ANY resolvable identifier, not on a LinkedIn URL specifically.
   */
  resolveOnDemand = false,
}: {
  contactId?: string | null;
  firstName?: string | null;
  fullName: string;
  profileImageUrl?: string | null;
  size?: "default" | "sm" | "lg";
  className?: string;
  resolveOnDemand?: boolean;
}) {
  const hasStoredPhoto =
    Boolean(profileImageUrl?.trim()) && !isUnusableAvatarUrl(profileImageUrl);
  // Prefer same-origin avatar route so LinkedIn CDN / data URLs load reliably.
  const photoUrl =
    contactId && (hasStoredPhoto || resolveOnDemand)
      ? `/api/avatars/${contactId}`
      : resolveContactPhotoUrl(profileImageUrl);
  const gender = guessGenderFromFirstName(firstName, fullName);
  const fallbackSrc = genderAvatarSrc(gender);
  const label = fullName.trim() || "Contact";

  return (
    <Avatar size={size} className={cn("bg-muted", className)} aria-label={label}>
      {photoUrl ? (
        <AvatarImage
          src={photoUrl}
          alt={label}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <AvatarFallback className="bg-muted p-0 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- static public avatar */}
        <img
          src={fallbackSrc}
          alt=""
          aria-hidden
          className="size-full object-cover"
          draggable={false}
          loading="lazy"
          decoding="async"
        />
      </AvatarFallback>
    </Avatar>
  );
}
