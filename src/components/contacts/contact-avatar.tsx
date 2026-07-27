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
  linkedinUrl,
  profileImageUrl,
  size = "lg",
  className,
  /**
   * When true and there is a LinkedIn URL but no stored photo, hit the avatar
   * API so a single profile view can resolve + persist on demand.
   * Leave false on list views to avoid Microlink stampeding.
   */
  resolveLinkedIn = false,
}: {
  contactId?: string | null;
  firstName?: string | null;
  fullName: string;
  linkedinUrl?: string | null;
  profileImageUrl?: string | null;
  size?: "default" | "sm" | "lg";
  className?: string;
  resolveLinkedIn?: boolean;
}) {
  const hasStoredPhoto =
    Boolean(profileImageUrl?.trim()) && !isUnusableAvatarUrl(profileImageUrl);
  const hasLinkedIn = Boolean(linkedinUrl?.trim());
  // Prefer same-origin avatar route so LinkedIn CDN / data URLs load reliably.
  // Only resolve LinkedIn on demand when explicitly opted in (profile pages).
  const photoUrl =
    contactId && (hasStoredPhoto || (resolveLinkedIn && hasLinkedIn))
      ? `/api/avatars/${contactId}`
      : resolveContactPhotoUrl(profileImageUrl);
  const gender = guessGenderFromFirstName(firstName, fullName);
  const fallbackSrc = genderAvatarSrc(gender);
  const label = fullName.trim() || "Contact";

  return (
    <Avatar size={size} className={cn("bg-muted", className)} aria-label={label}>
      {photoUrl ? (
        <AvatarImage src={photoUrl} alt={label} referrerPolicy="no-referrer" />
      ) : null}
      <AvatarFallback className="bg-muted p-0 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- static public avatar */}
        <img
          src={fallbackSrc}
          alt=""
          aria-hidden
          className="size-full object-cover"
          draggable={false}
        />
      </AvatarFallback>
    </Avatar>
  );
}
