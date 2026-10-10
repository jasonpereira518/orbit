"use client";

import { useState, useTransition } from "react";
import { SignOutButton, UserButton } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk-appearance";
import Link from "next/link";
import type { CareerProfile } from "@/db/schema";
import { clearLinkedInYou } from "@/actions/imports";
import { saveSenderBio, saveSocialLinks } from "@/actions/settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { Textarea } from "@/components/ui/textarea";
import { SENDER_BIO_MAX_LENGTH } from "@/lib/sender-profile";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * Sized per-instance rather than in `clerkAppearance`: the same object dresses
 * the UserButton in the sidebar and mobile nav, where the avatar is meant to
 * stay small. Only here does it stand in as the profile portrait.
 */
const profileAvatarAppearance = {
  ...clerkAppearance,
  elements: {
    ...clerkAppearance.elements,
    userButtonAvatarBox: "size-12",
    userButtonTrigger:
      "rounded-full ring-1 ring-border/60 focus-visible:ring-2 focus-visible:ring-ring",
  },
};

/** The label/value pairs worth showing, skipping anything that was never imported. */
function careerRows(c: CareerProfile): [string, string][] {
  const rows: [string, string | undefined][] = [
    ["Headline", c.profile?.headline],
    ["Current role", c.role ? `${c.role.title} at ${c.role.company}` : undefined],
    ["Industry", c.profile?.industry],
    ["Location", c.profile?.location],
    ["Skills", c.skills?.length ? `${c.skills.length}: ${c.skills.slice(0, 6).join(", ")}${c.skills.length > 6 ? "…" : ""}` : undefined],
    ["Job titles", c.roleKeywords?.join(", ")],
    ["Imported", c.importedAt ? new Date(c.importedAt).toLocaleDateString() : undefined],
  ];
  return rows.filter((r): r is [string, string] => Boolean(r[1]));
}

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
  initialSenderBio,
  initialCareer,
}: {
  profile: ProfileData | null;
  clerkEnabled: boolean;
  initialSocialLinks: SocialLinks;
  initialSenderBio: string;
  initialCareer: CareerProfile | null;
}) {
  const [socials, setSocials] = useState(initialSocialLinks);
  const [bio, setBio] = useState(initialSenderBio);
  const [career, setCareer] = useState(initialCareer);
  const [clearing, startClear] = useTransition();
  const [pending, start] = useTransition();
  const [bioPending, startBio] = useTransition();

  return (
    <SettingsSection
      title="Profile and account"
      description="Your identity and sign-in for Orbit."
    >

      {profile ? (
        <div className="flex flex-wrap items-center gap-4">
          {/* One face, and it is also the account menu. Clerk's UserButton
              renders the user's own picture, so standing it beside a second
              image of the same picture put the avatar on screen twice. */}
          {clerkEnabled ? (
            <UserButton appearance={profileAvatarAppearance} showName={false} />
          ) : profile.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.imageUrl}
              alt=""
              className="h-12 w-12 rounded-full border border-border/60 object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border/60 bg-muted text-sm font-medium text-ink">
              {profile.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">{profile.name}</p>
            {profile.email && (
              <p className="text-sm text-muted-foreground">{profile.email}</p>
            )}
          </div>
          {clerkEnabled && (
            <SignOutButton>
              <Button type="button" variant="outline" size="sm">
                Sign out
              </Button>
            </SignOutButton>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {clerkEnabled
              ? "Sign in to manage your profile."
              : "Running in local demo mode without Clerk."}
          </p>
          {clerkEnabled && (
            <SignOutButton>
              <Button type="button" variant="outline" size="sm">
                Sign out
              </Button>
            </SignOutButton>
          )}
        </div>
      )}

      <SettingsRow
        title="About you"
        description="One or two sentences: what you do, and what you are looking for. Orbit puts this in every message it drafts for you — without it, drafts have a name to sign off with and nothing to introduce."
      >
        <Textarea
          id="sender-bio"
          rows={3}
          value={bio}
          maxLength={SENDER_BIO_MAX_LENGTH}
          placeholder="Backend engineer at a seed-stage fintech, moving into platform work. Looking for staff-level roles and people who have made that jump."
          className="resize-y text-sm"
          onChange={(e) => setBio(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={bioPending}
            onClick={() =>
              startBio(async () => {
                try {
                  const saved = await saveSenderBio(bio);
                  // Reflect what was actually stored — the action collapses whitespace and
                  // truncates, so echoing the stored value keeps the box honest about it.
                  setBio(saved.senderBio);
                  toast.success(saved.senderBio ? "Saved" : "Cleared");
                } catch (err) {
                  toast.error(friendlyError(err, "Couldn’t save that — try again?"));
                }
              })
            }
          >
            {bioPending ? "Saving…" : "Save"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {bio.trim().length}/{SENDER_BIO_MAX_LENGTH}
          </p>
        </div>
      </SettingsRow>

      <SettingsRow
        title="From your LinkedIn export"
        description="Your headline, current role, skills and the job titles you watch. Orbit uses them to pick who is worth reaching out to; it never overwrites what you typed above."
      >
        {career ? (
          <div className="space-y-3">
            <dl className="space-y-1.5 text-sm">
              {careerRows(career).map(([label, value]) => (
                <div key={label} className="flex gap-3">
                  <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-words">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/imports" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Import a newer export
              </Link>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={clearing}
                onClick={() =>
                  startClear(async () => {
                    try {
                      await clearLinkedInYou();
                      setCareer(null);
                      toast.success("Removed what came from LinkedIn");
                    } catch (err) {
                      toast.error(friendlyError(err, TOAST_COPY.saveFailed));
                    }
                  })
                }
              >
                {clearing ? "Removing…" : "Remove imported details"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing imported yet.{" "}
            <Link href="/imports" className="underline underline-offset-2">
              Drop your LinkedIn export on Imports
            </Link>{" "}
            and Orbit reads Profile, Positions, Skills and Saved Job Alerts from it.
          </p>
        )}
      </SettingsRow>

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
                const res = await saveSocialLinks(socials);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                // Show what was stored: `linkedin.com/in/ada` comes back as its https link.
                setSocials({
                  linkedin: res.links.linkedin ?? "",
                  twitter: res.links.twitter ?? "",
                  github: res.links.github ?? "",
                  website: res.links.website ?? "",
                });
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
