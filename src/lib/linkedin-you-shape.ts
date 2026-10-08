/**
 * What the headers of the four "about you" LinkedIn files look like.
 *
 * Dependency-free on purpose: the browser-side file detector needs these, and the parsers next
 * door (`linkedin-you.ts`) pull in server-only sanitizing. Keeping the predicates here is what
 * stops `node:crypto` from landing in the client bundle.
 */

/** The import targets that describe the user. They fill `career_profile`, not the contacts list. */
export type YouTarget = "linkedin_profile" | "linkedin_positions" | "linkedin_skills" | "linkedin_alerts";

export function isYouTarget(target: string): target is YouTarget {
  return (
    target === "linkedin_profile" ||
    target === "linkedin_positions" ||
    target === "linkedin_skills" ||
    target === "linkedin_alerts"
  );
}

const lowered = (fields: string[]) => fields.map((f) => f.trim().toLowerCase());

/** Profile.csv. Name columns alone would match half the exports, so it needs these two. */
export function looksLikeLinkedInProfile(fields: string[]): boolean {
  const lower = lowered(fields);
  return lower.includes("headline") && lower.includes("maiden name");
}

export function looksLikeLinkedInPositions(fields: string[]): boolean {
  const lower = lowered(fields);
  return lower.includes("company name") && lower.includes("started on") && lower.includes("finished on");
}

export function looksLikeLinkedInAlerts(fields: string[]): boolean {
  return lowered(fields).includes("alert_parameters");
}

/** A one-column `Name` file. Too generic to sniff alone, so detection also requires the filename. */
export function looksLikeLinkedInSkills(fields: string[]): boolean {
  const lower = lowered(fields);
  return lower.length === 1 && lower[0] === "name";
}
