"use client";

import { SignOutButton, UserButton } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { Button } from "@/components/ui/button";

type ProfileData = {
  id: string;
  name: string;
  email: string;
  imageUrl?: string;
};

export function ProfileSettings({
  profile,
  clerkEnabled,
}: {
  profile: ProfileData | null;
  clerkEnabled: boolean;
}) {

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
    </section>
  );
}
