"use client";

import { useState, useTransition } from "react";
import { SignOutButton, UserButton } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { saveSocialLinks } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/toast";

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
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Profile and account</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your identity and sign-in for Orbit.
        </p>
      </div>

      {profile ? (
        <div className="flex flex-wrap items-center gap-4">
          {profile.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.imageUrl}
              alt=""
              className="h-12 w-12 rounded-full border border-border/60 object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border/60 bg-muted text-sm font-medium text-primary">
              {profile.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium text-primary">{profile.name}</p>
            {profile.email && (
              <p className="text-sm text-muted-foreground">{profile.email}</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {clerkEnabled
            ? "Sign in to manage your profile."
            : "Running in local demo mode without Clerk."}
        </p>
      )}

      {clerkEnabled && (
        <div className="flex flex-wrap items-center gap-2">
          <UserButton appearance={clerkAppearance} showName={false} />
          <SignOutButton>
            <Button type="button" variant="outline" size="sm">
              Sign out
            </Button>
          </SignOutButton>
        </div>
      )}

      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-medium text-primary">Your socials</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Shown when you click the sun in Constellation.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
          className="mt-3"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                await saveSocialLinks(socials);
                toast.success("Social links saved");
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Could not save"
                );
              }
            })
          }
        >
          {pending ? "Saving…" : "Save socials"}
        </Button>
      </div>
    </section>
  );
}
