/**
 * Turning a LinkedIn "about you" file into a before/after the person can approve, and into the
 * patch that applies what they approved. Pure: the database read and write live in
 * `src/actions/imports.ts`, which hands the current values in.
 *
 * `previewYou` and `patchYou` share one field list so what the review showed and what gets
 * written cannot drift apart: a key the review never offered is never written.
 */
import type { CareerProfile } from "@/db/schema";
import {
  parseLinkedInAlertsCsv,
  parseLinkedInPositionsCsv,
  parseLinkedInProfileCsv,
  parseLinkedInSkillsCsv,
} from "@/lib/linkedin-you";
import { LinkedInExportError } from "@/lib/linkedin-connections";
import { normalizeSenderBio } from "@/lib/sender-profile";
import type { YouTarget } from "@/lib/linkedin-you-shape";

export type YouField = {
  /** Stable: also the value the review's checkboxes carry back (`QueuedImport.ids`). */
  key: string;
  label: string;
  /** What Orbit holds now, or null when nothing. */
  before: string | null;
  after: string;
  /** Whether the review ticks it to begin with. */
  defaultOn: boolean;
};

export type YouCurrent = { career: CareerProfile | null; senderBio: string | null };

const PROFILE_KEYS = [
  ["headline", "Headline"],
  ["industry", "Industry"],
  ["location", "Location"],
  ["summary", "Summary"],
] as const;

const PREVIEW_TERMS = 8;

function termsLine(terms: string[]): string {
  const shown = terms.slice(0, PREVIEW_TERMS).join(", ");
  return terms.length > PREVIEW_TERMS ? `${shown} and ${terms.length - PREVIEW_TERMS} more` : shown;
}

function roleLine(role: { title: string; company: string }): string {
  return `${role.title} at ${role.company}`;
}

/** Everything the file offers, each with what it would replace. Throws `LinkedInExportError`. */
export function previewYou(target: YouTarget, text: string, current: YouCurrent): YouField[] {
  const career = current.career ?? {};

  if (target === "linkedin_profile") {
    const parsed = parseLinkedInProfileCsv(text);
    const fields: YouField[] = PROFILE_KEYS.flatMap(([key, label]) => {
      const after = parsed[key];
      if (!after) return [];
      const before = career.profile?.[key] ?? null;
      return [{ key: `profile.${key}`, label, before, after, defaultOn: true }];
    });
    // The one field the person writes themselves. Offered, but only ticked when it is empty,
    // so an import never replaces what they typed unless they say so.
    const about = parsed.headline ? normalizeSenderBio(parsed.headline) : null;
    if (about) {
      fields.push({
        key: "about",
        label: "Your “About you” line",
        before: current.senderBio,
        after: about,
        defaultOn: !current.senderBio,
      });
    }
    return fields;
  }

  if (target === "linkedin_positions") {
    const role = parseLinkedInPositionsCsv(text);
    if (!role) throw new LinkedInExportError("Positions.csv has no current role — every role has an end date.");
    return [
      {
        key: "role",
        label: "Current role",
        before: career.role ? roleLine(career.role) : null,
        after: roleLine(role),
        defaultOn: true,
      },
    ];
  }

  if (target === "linkedin_skills") {
    const skills = parseLinkedInSkillsCsv(text);
    return [
      {
        key: "skills",
        label: `Skills (${skills.length})`,
        before: career.skills?.length ? termsLine(career.skills) : null,
        after: termsLine(skills),
        defaultOn: true,
      },
    ];
  }

  const keywords = parseLinkedInAlertsCsv(text);
  if (!keywords.length) {
    throw new LinkedInExportError("Your saved job alerts don't name a job title, so there is nothing to import.");
  }
  return [
    {
      key: "roleKeywords",
      label: "Job titles you’re watching",
      before: career.roleKeywords?.length ? termsLine(career.roleKeywords) : null,
      after: termsLine(keywords),
      defaultOn: true,
    },
  ];
}

export type YouPatch = {
  /** Top-level keys of `career_profile` to replace. Merged with `||`, so the rest is untouched. */
  career: CareerProfile;
  /** The new `sender_bio`, or null to leave it alone. */
  senderBio: string | null;
  /** The line the queue shows when the step finishes. */
  message: string;
};

/**
 * What to write for the keys the person left ticked.
 *
 * Re-parses the text rather than trusting a client-built patch: the browser only sends back
 * which keys it kept. Keys the file did not offer are ignored.
 */
export function patchYou(
  target: YouTarget,
  text: string,
  keys: readonly string[],
  current: YouCurrent,
  now: Date,
): YouPatch | null {
  const offered = new Set(previewYou(target, text, current).map((f) => f.key));
  const chosen = new Set(keys.filter((k) => offered.has(k)));
  if (!chosen.size) return null;

  const career: CareerProfile = { importedAt: now.toISOString() };
  let senderBio: string | null = null;

  if (target === "linkedin_profile") {
    const parsed = parseLinkedInProfileCsv(text);
    // Merge into what is there, so unticking Summary keeps the old one.
    const profile = { ...(current.career?.profile ?? {}) };
    for (const [key] of PROFILE_KEYS) {
      if (chosen.has(`profile.${key}`) && parsed[key]) profile[key] = parsed[key];
    }
    career.profile = profile;
    if (chosen.has("about") && parsed.headline) senderBio = normalizeSenderBio(parsed.headline);
  } else if (target === "linkedin_positions") {
    career.role = parseLinkedInPositionsCsv(text) ?? undefined;
  } else if (target === "linkedin_skills") {
    career.skills = parseLinkedInSkillsCsv(text);
  } else {
    career.roleKeywords = parseLinkedInAlertsCsv(text);
  }

  const done = chosen.size;
  return { career, senderBio, message: `Saved ${done} ${done === 1 ? "detail" : "details"} from your LinkedIn export` };
}
