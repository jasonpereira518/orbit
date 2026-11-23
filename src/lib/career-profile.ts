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
  MAX_SCHOOLS,
  parseLinkedInAlertsCsv,
  parseLinkedInEducationCsv,
  parseLinkedInEducationHistoryCsv,
  parseLinkedInPositionHistoryCsv,
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

export type YouCurrent = {
  career: CareerProfile | null;
  senderBio: string | null;
  /** `user_settings.schools`: typed in Settings, or imported from Education.csv. */
  schools: string[];
};

/** What Settings already lists, then the file's new ones — added, never replaced. */
export function mergedSchools(current: string[], incoming: string[]): string[] {
  const seen = new Set(current.map((s) => s.toLowerCase()));
  return [...current, ...incoming.filter((s) => !seen.has(s.toLowerCase()))].slice(0, MAX_SCHOOLS);
}

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

const HISTORY_PREVIEW = 3;

function rolesPhrase(n: number): string {
  return `${n} ${n === 1 ? "role" : "roles"}`;
}

function listLine(items: string[]): string {
  const shown = items.slice(0, HISTORY_PREVIEW).join(", ");
  return items.length > HISTORY_PREVIEW ? `${shown} and ${items.length - HISTORY_PREVIEW} more` : shown;
}

/** `history`: also offer the full work and school history (the dark deep-read surface). */
export type YouOptions = { history?: boolean };

/** Everything the file offers, each with what it would replace. Throws `LinkedInExportError`. */
export function previewYou(target: YouTarget, text: string, current: YouCurrent, opts: YouOptions = {}): YouField[] {
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
    const history = opts.history ? parseLinkedInPositionHistoryCsv(text) : [];
    if (!role && !history.length) {
      throw new LinkedInExportError("Positions.csv has no current role — every role has an end date.");
    }
    const out: YouField[] = [];
    if (role) {
      out.push({
        key: "role",
        label: "Current role",
        before: career.role ? roleLine(career.role) : null,
        after: roleLine(role),
        defaultOn: true,
      });
    }
    if (history.length) {
      out.push({
        key: "positions",
        label: `Work history (${rolesPhrase(history.length)})`,
        before: career.positions?.length ? rolesPhrase(career.positions.length) : null,
        after: listLine(history.map(roleLine)),
        defaultOn: true,
      });
    }
    return out;
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

  if (target === "linkedin_education") {
    const schools = mergedSchools(current.schools, parseLinkedInEducationCsv(text));
    const out: YouField[] = [
      {
        key: "schools",
        label: "Schools you went to",
        before: current.schools.length ? current.schools.join(", ") : null,
        after: schools.join(", "),
        defaultOn: true,
      },
    ];
    const history = opts.history ? parseLinkedInEducationHistoryCsv(text) : [];
    if (history.length) {
      out.push({
        key: "education",
        label: `Degrees and dates (${history.length})`,
        before: career.education?.length ? listLine(career.education.map((e) => e.school)) : null,
        after: listLine(history.map((e) => e.school)),
        defaultOn: true,
      });
    }
    return out;
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
  /** The whole new `user_settings.schools` list, or null to leave it alone. */
  schools: string[] | null;
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
  opts: YouOptions = {},
): YouPatch | null {
  const offered = new Set(previewYou(target, text, current, opts).map((f) => f.key));
  const chosen = new Set(keys.filter((k) => offered.has(k)));
  if (!chosen.size) return null;

  const career: CareerProfile = { importedAt: now.toISOString() };
  let senderBio: string | null = null;
  let schools: string[] | null = null;

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
    // Each key only when ticked: with the history on, a file offers two.
    if (chosen.has("role")) career.role = parseLinkedInPositionsCsv(text) ?? undefined;
    if (chosen.has("positions")) career.positions = parseLinkedInPositionHistoryCsv(text);
  } else if (target === "linkedin_skills") {
    career.skills = parseLinkedInSkillsCsv(text);
  } else if (target === "linkedin_education") {
    if (chosen.has("schools")) schools = mergedSchools(current.schools, parseLinkedInEducationCsv(text));
    if (chosen.has("education")) career.education = parseLinkedInEducationHistoryCsv(text);
  } else {
    career.roleKeywords = parseLinkedInAlertsCsv(text);
  }

  const done = chosen.size;
  return { career, senderBio, schools, message: `Saved ${done} ${done === 1 ? "detail" : "details"} from your LinkedIn export` };
}
