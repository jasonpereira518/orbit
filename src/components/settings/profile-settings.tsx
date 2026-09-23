"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { saveSocialLinks } from "@/actions/settings";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

type ProfileData = {
  id: string;
  name: string;
  email: string;
  imageUrl?: string;
};

type SocialLinks = {
  linkedin: string;
  twitter: string;
  github: string;
  website: string;
};

export function ProfileSettings({
  profile,
  clerkEnabled,
  initialSocialLinks,
}: {
  profile: ProfileData | null;
  clerkEnabled: boolean;
  initialSocialLinks: SocialLinks;
}) {
  const [socials, setSocials] = useState(initialSocialLinks);
  const [pending, start] = useTransition();

  return (
    <SettingsSection
      title="Profile and account"
      description="Your identity and sign-in for Orbit."
    >

      {profile ? (
        <div className="flex flex-wrap items-center gap-4">
          <Avatar size="lg">
            {profile.imageUrl && <AvatarImage src={profile.imageUrl} alt="" />}
            <AvatarFallback>{profile.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">{profile.name}</p>
            {profile.email && (
              <p className="text-sm text-muted-foreground">{profile.email}</p>
            )}
          </div>
          {clerkEnabled && (
            <Button type="button" variant="outline" size="sm" render={<Link href="/settings/account" />}>
              Manage account
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {clerkEnabled
              ? "Sign in to manage your profile."
              : "Running in local demo mode without Clerk."}
          </p>
        </div>
      )}

      <SettingsRow
        title="Your socials"
        description="Shown when you click the sun in Constellation."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["linkedin", "LinkedIn URL"],
              ["twitter", "X / Twitter URL"],
              ["github", "GitHub URL"],
              ["website", "Personal site"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`social-${key}`}>{label}</Label>
              <Input
                id={`social-${key}`}
                type="url"
                placeholder="https://"
                value={socials[key]}
                onChange={(e) =>
                  setSocials((s) => ({ ...s, [key]: e.target.value }))
                }
              />
            </div>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                await saveSocialLinks(socials);
                toast.success("Social links saved");
              } catch (err) {
                toast.error(
                  friendlyError(err, TOAST_COPY.saveFailed)
                );
              }
            })
          }
        >
          {pending ? "Saving…" : "Save socials"}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
