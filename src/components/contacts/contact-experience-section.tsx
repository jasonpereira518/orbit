"use client";

import { useState, useTransition } from "react";
import { format } from "date-fns";
import { ArrowRightLeft, Building2, GraduationCap, Sparkles } from "lucide-react";
import {
  formatExperienceDates,
  jobChangeSentence,
  type ExperienceEntry,
} from "@/lib/contact-profile-format";
import { findContactWorkHistory } from "@/actions/contact-profile";
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
    source: "extension" | "web" | "apollo";
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
  /** Work history is found by a web search on the person's own AI key. */
  canSearchWeb: boolean;
  /** Logged job moves, newest first — survives every history refresh. */
  moves: Array<{
    id: string;
    kind: "joined" | "left" | "title_change";
    fromOrg: string | null;
    fromTitle: string | null;
    toOrg: string | null;
    toTitle: string | null;
    detectedAt: string;
  }>;
  /**
   * When the background check looks at this contact again. Null unless it is a real date
   * ahead — the loader drops a lease or an overdue check (`getWorkHistoryTracking`).
   */
  nextCheckAt: string | null;
};

/** What to say when a search came back with nothing to store. */
function searchFailureCopy(outcome: string): string {
  switch (outcome) {
    case "unsure":
      return "Found pages that might be someone else with this name, so nothing was saved.";
    case "not_found":
      return "Couldn’t find their work history on the web.";
    case "no_anchor":
      return "Add a LinkedIn URL to this contact first.";
    case "no_ai":
      return "Add an AI key in Settings to search the web for this.";
    case "rate_limited":
      return "That’s today’s work-history searches — try again tomorrow.";
    case "outranked":
      return "This profile came from LinkedIn directly and is kept as is.";
    default:
      return "Couldn’t search for their work history — try again?";
  }
}

function FindHistoryButton({
  contactId,
  label,
}: {
  contactId: string;
  label: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const { outcome } = await findContactWorkHistory(contactId);
            if (outcome !== "saved") setError(searchFailureCopy(outcome));
          });
        }}
      >
        <Sparkles className="size-3.5" aria-hidden />
        {pending ? "Searching the web…" : label}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {/* Keyed by index, not by value: LinkedIn happily lists the same skill twice, and
            a duplicated name would collide as a key. Nothing here reorders or animates. */}
        {items.map((item, index) => (
          <span
            key={`${index}-${item}`}
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
  canSearchWeb,
  moves,
  nextCheckAt,
}: ExperienceSectionProps) {

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
          {!linkedinUrl && (
            <p className="text-sm text-muted-foreground">
              Add a LinkedIn URL to this contact to fill their profile.
            </p>
          )}
          {linkedinUrl && canSearchWeb && (
            <div className="pt-1">
              <FindHistoryButton contactId={contactId} label="Find work history" />
            </div>
          )}
          {/* Honest rather than silent: without this, a contact with no AI key configured
              just looks like there is no way to fill this in. */}
          {linkedinUrl && !canSearchWeb && (
            <p className="text-sm text-muted-foreground">
              Add an AI key in{" "}
              <a
                href="/settings"
                className="font-medium text-ink underline-offset-2 hover:underline"
              >
                Settings
              </a>{" "}
              to find their work history with a web search.
            </p>
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
        {/* The headline is the one line the person wrote to describe themselves, and it is
            often the only prose an Apollo-sourced profile has. It was captured, stored and
            passed down here but never rendered. */}
        {profile.headline && (
          <p className="text-sm font-medium leading-snug text-ink">{profile.headline}</p>
        )}
        {profile.about && <ExpandableText text={profile.about} lines={4} />}

        {moves.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <ArrowRightLeft className="size-3.5" aria-hidden /> Career moves
            </p>
            <ul>
              {moves.map((move) => (
                <li
                  key={move.id}
                  className="border-b border-border/50 py-2.5 last:border-b-0 last:pb-0"
                >
                  <p className="text-sm font-medium text-ink">{jobChangeSentence(move)}</p>
                  <p className="text-xs text-muted-foreground">
                    Noticed {format(new Date(move.detectedAt), "MMM yyyy")}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

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
          Provenance, stated plainly. An inferred profile has no About and no
          skills, and without this line it reads as a person who wrote
          nothing about themselves — or as their LinkedIn page, which it is not.
        */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
          <p className="text-xs text-muted-foreground">
            {profile.source === "extension"
              ? `From LinkedIn · captured ${format(new Date(profile.capturedAt), "MMM d, yyyy")}`
              : profile.source === "web"
                ? `Found by web search · checked ${format(new Date(profile.capturedAt), "MMM d, yyyy")} · may be incomplete`
                : "From Apollo, not their LinkedIn page directly"}
            {nextCheckAt && ` · next check ~${format(new Date(nextCheckAt), "MMM yyyy")}`}
            {profile.warnings.length > 0 && " · This capture may be incomplete."}
          </p>
          {profile.source !== "extension" && linkedinUrl && canSearchWeb && (
            <FindHistoryButton contactId={contactId} label="Search again" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
