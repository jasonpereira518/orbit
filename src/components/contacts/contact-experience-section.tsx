"use client";

import { useState, useTransition } from "react";
import { format } from "date-fns";
import { Building2, GraduationCap, Sparkles } from "lucide-react";
import {
  formatExperienceDates,
  type ExperienceEntry,
} from "@/lib/contact-profile-format";
import { fillContactProfileFromApollo } from "@/actions/contact-profile";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExpandableText } from "@/components/ui/expandable-text";

/**
 * Client component: it has a collapsible About and a button wired to a server
 * action, so it needs `useState`/`useTransition`. That means it may import
 * only `@/lib/contact-profile-format` (pure, `import type`s from the schema)
 * — never `@/lib/contact-profile`, which reaches `@/db` and fails the build
 * with a `node:fs` chunking error that names neither file. The page loads the
 * data server-side and passes already-serializable props in below.
 */
export type ProfileExperienceEntry = ExperienceEntry & {
  id: string;
  description: string | null;
  location: string | null;
};

export type ExperienceSectionProps = {
  contactId: string;
  /** Null when nothing has been captured yet — the empty state is the entry point. */
  profile: {
    source: "extension" | "apollo";
    capturedAt: string;
    warnings: string[];
    headline: string | null;
    about: string | null;
    skills: string[];
    certifications: string[];
    volunteering: string[];
    publications: string[];
    /** Already ordered by the server; do not re-sort. */
    experiences: ProfileExperienceEntry[];
  } | null;
  linkedinUrl: string | null;
  canUseApollo: boolean;
};

function ChipRow({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded-full border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function EntryRow({ entry }: { entry: ProfileExperienceEntry }) {
  const dates = formatExperienceDates(entry);
  const heading = [entry.title, entry.organization].filter(Boolean).join(" · ");
  return (
    <li className="border-b border-border/50 py-3 last:border-b-0 last:pb-0">
      <p className="text-sm font-medium text-ink">{heading}</p>
      {(dates || entry.location) && (
        <p className="text-xs text-muted-foreground">
          {[dates, entry.location].filter(Boolean).join(" · ")}
        </p>
      )}
      {entry.description && (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {entry.description}
        </p>
      )}
    </li>
  );
}

export function ContactExperienceSection({
  contactId,
  profile,
  linkedinUrl,
  canUseApollo,
}: ExperienceSectionProps) {
  const [pending, startTransition] = useTransition();
  const [fillError, setFillError] = useState<string | null>(null);

  // --- empty state: this section is the feature's entry point, not a blank card ---
  if (!profile) {
    return (
      <Card className="border-border/70 shadow-none">
        <CardHeader>
          <CardTitle>Experience</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Their roles, schools, and About — so you can ask about any of it
            in chat.
          </p>
          {linkedinUrl ? (
            <p className="text-sm text-muted-foreground">
              Open{" "}
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-ink underline-offset-2 hover:underline"
              >
                their LinkedIn profile
              </a>{" "}
              and press &quot;Capture experience&quot; in the Orbit extension.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Add a LinkedIn URL to this contact to capture their profile.
            </p>
          )}
          {linkedinUrl && canUseApollo && (
            <div className="pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setFillError(null);
                  startTransition(async () => {
                    const result = await fillContactProfileFromApollo(contactId);
                    if (!result.filled) {
                      // "no_match" conflates two cases the action cannot tell apart:
                      // Apollo found nobody, or found them but has no employment
                      // history on file. Naming a specific cause here would claim
                      // certainty the action doesn't have, so this stays honest
                      // about the ambiguity and points at the reliable path instead.
                      setFillError(
                        result.reason === "no_match"
                          ? "Apollo didn't return a usable profile for them — try capturing from their LinkedIn page instead."
                          : result.reason === "no_url"
                            ? "Add a LinkedIn URL to this contact first."
                            : "Couldn't fill this profile."
                      );
                    }
                  });
                }}
              >
                <Sparkles className="size-3.5" aria-hidden />
                {pending ? "Filling…" : "Fill from Apollo"}
              </Button>
            </div>
          )}
          {/* Honest rather than silent: without this, a contact with no Apollo key
              configured just looks like Apollo isn't an option here at all. */}
          {linkedinUrl && !canUseApollo && (
            <p className="text-sm text-muted-foreground">
              Add an Apollo API key in{" "}
              <a
                href="/settings"
                className="font-medium text-ink underline-offset-2 hover:underline"
              >
                Settings
              </a>{" "}
              to fill this in from Apollo instead.
            </p>
          )}
          {fillError && (
            <p className="text-sm text-destructive">{fillError}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  const roles = profile.experiences.filter((e) => e.kind === "role");
  const education = profile.experiences.filter((e) => e.kind === "education");

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle>Experience</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {profile.about && <ExpandableText text={profile.about} lines={4} />}

        {roles.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Building2 className="size-3.5" aria-hidden /> Roles
            </p>
            <ul>
              {roles.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </div>
        )}

        {education.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <GraduationCap className="size-3.5" aria-hidden /> Education
            </p>
            <ul>
              {education.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-3">
          <ChipRow label="Skills" items={profile.skills} />
          <ChipRow label="Certifications" items={profile.certifications} />
          <ChipRow label="Volunteering" items={profile.volunteering} />
          <ChipRow label="Publications" items={profile.publications} />
        </div>

        {/*
          Provenance, stated plainly. An Apollo profile has no About and no
          skills, and without this line it reads as a person who wrote
          nothing about themselves.
        */}
        <p className="border-t border-border/50 pt-3 text-xs text-muted-foreground">
          {profile.source === "extension"
            ? `From LinkedIn · captured ${format(new Date(profile.capturedAt), "MMM d, yyyy")}`
            : "From Apollo, not their LinkedIn page directly"}
          {profile.warnings.length > 0 && " · This capture may be incomplete."}
        </p>
      </CardContent>
    </Card>
  );
}
