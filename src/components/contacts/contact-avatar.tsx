"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { linkedinAvatarUrl } from "@/lib/contact-avatar";
import {
  guessGenderFromFirstName,
  type GuessedGender,
} from "@/lib/guess-gender";
import { cn } from "@/lib/utils";

export function ContactAvatar({
  firstName,
  fullName,
  linkedinUrl,
  profileImageUrl,
  size = "lg",
  className,
}: {
  firstName?: string | null;
  fullName: string;
  linkedinUrl?: string | null;
  profileImageUrl?: string | null;
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  const photoUrl =
    profileImageUrl?.trim() || linkedinAvatarUrl(linkedinUrl) || null;
  const gender = guessGenderFromFirstName(firstName, fullName);
  const label = fullName.trim() || "Contact";

  return (
    <Avatar size={size} className={cn("bg-muted", className)} aria-label={label}>
      {photoUrl ? (
        <AvatarImage src={photoUrl} alt={label} referrerPolicy="no-referrer" />
      ) : null}
      <AvatarFallback className="bg-muted p-0 overflow-hidden">
        <GenderSilhouette gender={gender} />
      </AvatarFallback>
    </Avatar>
  );
}

function GenderSilhouette({ gender }: { gender: GuessedGender }) {
  if (gender === "female") {
    return (
      <svg
        viewBox="0 0 40 40"
        className="size-full text-muted-foreground/80"
        aria-hidden
      >
        <circle cx="20" cy="14" r="7" fill="currentColor" opacity="0.85" />
        <path
          fill="currentColor"
          d="M8 36c0-7.5 5.4-13 12-13s12 5.5 12 13H8z"
          opacity="0.85"
        />
        {/* Soft shoulder / hair cue */}
        <path
          fill="currentColor"
          d="M11 16c0-5 3.5-9.5 9-9.5S29 11 29 16c0 1.2-.3 2.3-.8 3.3-1.4-2.8-3.9-4.5-8.2-4.5s-6.8 1.7-8.2 4.5c-.5-1-.8-2.1-.8-3.3z"
          opacity="0.35"
        />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 40 40"
      className="size-full text-muted-foreground/80"
      aria-hidden
    >
      <circle cx="20" cy="14" r="7" fill="currentColor" opacity="0.85" />
      <path
        fill="currentColor"
        d="M7 36c1.2-7.2 6.2-12 13-12s11.8 4.8 13 12H7z"
        opacity="0.85"
      />
    </svg>
  );
}
