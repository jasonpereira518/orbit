"use client";

import { useState, useTransition } from "react";
import { SignOutButton, UserButton } from "@clerk/nextjs";
import { clerkAppearance } from "@/lib/clerk-appearance";
import Link from "next/link";
import type { CareerProfile } from "@/db/schema";
import { clearLinkedInYou } from "@/actions/imports";
import { saveSenderBio, saveSocialLinks } from "@/actions/settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import { LinkedInMark } from "@/components/settings/provider-marks";
import { integrationHref } from "@/components/settings/sections";
import {
  Briefcase,
  Building2,
  MapPin,
  Quote,
  RefreshCw,
  Sparkles,
  Target,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

/** LinkedIn's brand blue, the tile tone the LinkedIn integration page uses (linkedin-settings.tsx). */
const LINKEDIN_BLUE = "#0A66C2";
const SKILL_CHIPS = 6;

type CareerRow = { icon: LucideIcon; label: string } & (
  | { value: string; /** Shown on hover/focus: LinkedIn's About summary under the headline. */ hint?: string }
  | { chips: string[] }
);

/** The rows worth showing, skipping anything that was never imported. */
function careerRows(c: CareerProfile): CareerRow[] {
  const rows: (CareerRow | null)[] = [
    // Word for word as LinkedIn has it; the About summary rides along on hover.
    c.profile?.headline
      ? { icon: Quote, label: "Headline", value: c.profile.headline, hint: c.profile.summary || undefined }
      : null,
    c.role ? { icon: Briefcase, label: "Current role", value: `${c.role.title} at ${c.role.company}` } : null,
    c.profile?.industry ? { icon: Building2, label: "Industry", value: c.profile.industry } : null,
    c.profile?.location ? { icon: MapPin, label: "Location", value: c.profile.location } : null,
    c.skills?.length
      ? {
          icon: Sparkles,
          label: "Skills",
          chips: [
            ...c.skills.slice(0, SKILL_CHIPS),
            ...(c.skills.length > SKILL_CHIPS ? [`+${c.skills.length - SKILL_CHIPS} more`] : []),
          ],
        }
      : null,
    c.roleKeywords?.length ? { icon: Target, label: "Job titles", chips: c.roleKeywords } : null,
  ];
  return rows.filter((r): r is CareerRow => r !== null);
}

/** The FeatureRow icon tile (account-page.tsx), washed in LinkedIn blue. */
function LinkedInTile() {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-lg"
      style={{ backgroundColor: `color-mix(in srgb, ${LINKEDIN_BLUE} 14%, transparent)` }}
    >
      <LinkedInMark className="size-4" />
    </span>
  );
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

/** Who is signed in, and the way out. */
export function AccountSettings({
  profile,
  clerkEnabled,
}: {
  profile: ProfileData | null;
  clerkEnabled: boolean;
}) {
  return (
    <SettingsSection title="Account" description="Your identity and sign-in for Orbit.">
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
    </SettingsSection>
  );
}

/** What Orbit knows about you: the bio you wrote, and what came in from LinkedIn. */
export function AboutYouSettings({
  initialSenderBio,
  initialCareer,
}: {
  initialSenderBio: string;
  initialCareer: CareerProfile | null;
}) {
  const [bio, setBio] = useState(initialSenderBio);
  const [career, setCareer] = useState(initialCareer);
  const [clearing, startClear] = useTransition();
  const [bioPending, startBio] = useTransition();
  // A failed save stays next to its button until the next attempt; the toast alone could
  // time out before it was read.
  const [bioError, setBioError] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);

  return (
    <SettingsSection title="About you">
      <SettingsRow
        title="Bio"
        labelFor="sender-bio"
        description="One or two sentences on what you do and what you’re looking for. Orbit adds it to every draft."
      >
        <Textarea
          id="sender-bio"
          aria-describedby="sender-bio-description"
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
                setBioError(null);
                try {
                  const saved = await saveSenderBio(bio);
                  // Reflect what was actually stored — the action collapses whitespace and
                  // truncates, so echoing the stored value keeps the box honest about it.
                  setBio(saved.senderBio);
                  toast.success(saved.senderBio ? "Saved" : "Cleared");
                } catch (err) {
                  const message = friendlyError(err, "Couldn’t save that — try again?");
                  toast.error(message);
                  setBioError(message);
                }
              })
            }
          >
            {bioPending ? "Saving…" : "Save"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {bio.trim().length}/{SENDER_BIO_MAX_LENGTH}
          </p>
          <FormError className="basis-full">{bioError}</FormError>
        </div>
      </SettingsRow>

      <SettingsRow
        title="From your LinkedIn"
        description="What Orbit learned about you from LinkedIn. It helps pick who’s worth reaching out to, and never overwrites what you wrote above."
      >
        {/* `aim` alone (onboarding's, kept by Remove) is not an import: no rows to show. */}
        {career && careerRows(career).length ? (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
            <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
              <LinkedInTile />
              <p className="min-w-0 flex-1 text-sm font-medium text-ink">Your LinkedIn profile</p>
              <p className="shrink-0 text-xs text-muted-foreground">
                {career.importedAt
                  ? `Imported ${new Date(career.importedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                  : "From setup"}
              </p>
            </div>
            <dl className="divide-y divide-border/60 text-sm">
              {careerRows(career).map((row) => (
                <div key={row.label} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-2.5 sm:flex-nowrap">
                  <dt className="flex w-32 shrink-0 items-center gap-2 text-muted-foreground">
                    <row.icon className="size-4 shrink-0" aria-hidden />
                    {row.label}
                  </dt>
                  <dd className="min-w-0 flex-1 break-words text-ink">
                    {"chips" in row ? (
                      <span className="flex flex-wrap gap-1.5">
                        {row.chips.map((chip) => (
                          <span
                            key={chip}
                            className="whitespace-nowrap rounded-full border border-border/70 bg-muted/40 px-2.5 py-0.5 text-xs"
                          >
                            {chip}
                          </span>
                        ))}
                      </span>
                    ) : row.hint ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              tabIndex={0}
                              className="cursor-help rounded-sm underline decoration-border decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                            />
                          }
                        >
                          {row.value}
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="start" className="max-w-sm leading-relaxed">
                          {row.hint}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      row.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-4 py-3">
              <Link
                href={integrationHref("linkedin")}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Update from LinkedIn
              </Link>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={clearing}
                onClick={() =>
                  startClear(async () => {
                    setClearError(null);
                    try {
                      await clearLinkedInYou();
                      setCareer(null);
                      toast.success("Removed what came from LinkedIn");
                    } catch (err) {
                      const message = friendlyError(err, TOAST_COPY.saveFailed);
                      toast.error(message);
                      setClearError(message);
                    }
                  })
                }
              >
                <Trash2 className="size-3.5" aria-hidden />
                {clearing ? "Removing…" : "Remove imported details"}
              </Button>
              <FormError className="basis-full">{clearError}</FormError>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border/70 px-4 py-3">
            <LinkedInTile />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Nothing from LinkedIn yet</p>
              <p className="text-sm text-muted-foreground">
                Your export brings your headline, roles, skills and saved job alerts.
              </p>
            </div>
            <Link
              href={integrationHref("linkedin")}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Upload className="size-3.5" aria-hidden />
              Upload your export
            </Link>
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

/** The links on your own star in Constellation. */
export function SocialLinksSettings({ initialSocialLinks }: { initialSocialLinks: SocialLinks }) {
  const [socials, setSocials] = useState(initialSocialLinks);
  const [pending, start] = useTransition();
  const [socialsError, setSocialsError] = useState<string | null>(null);

  return (
    <SettingsSection title="Your socials" description="Shown when you click the sun in Constellation.">
      <div className="space-y-3">
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
              setSocialsError(null);
              try {
                const res = await saveSocialLinks(socials);
                if (!res.ok) {
                  // A link that did not parse: say so by the fields, not in a passing toast.
                  setSocialsError(res.error);
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
                const message = friendlyError(err, TOAST_COPY.saveFailed);
                toast.error(message);
                setSocialsError(message);
              }
            })
          }
        >
          {pending ? "Saving…" : "Save socials"}
        </Button>
        <FormError className="mt-2">{socialsError}</FormError>
      </div>
    </SettingsSection>
  );
}
