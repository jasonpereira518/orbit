/**
 * What Orbit does with each file in a LinkedIn data export.
 *
 * Every CSV in the export is kept (`import_files`) so a later Orbit can read files it ignores
 * today, except the ones it has no business holding. Those never leave the browser.
 *
 * Pure and dependency-free: detection (browser), the save action and the smokes all read it.
 */

export type ExportFileRole = "parsed" | "stored" | "private";

/**
 * Files LinkedIn includes that describe the account holder in ways Orbit never needs: payment
 * receipts, the sign-up IP, identity verification (birth year, ID document), the raw text of
 * uploaded résumés, ad-targeting segments, and answers to job-application screening questions.
 */
const PRIVATE = [
  /^receipts/,
  /^registration\.csv$/,
  /^verifications\//,
  /(^|\/)verifications\.csv$/,
  /^private_identity_asset\.csv$/,
  /^ad_targeting\.csv$/,
  /(^|\/)job applicant saved screening question responses\.csv$/,
  /(^|\/)job applicant saved answers\.csv$/,
];

/** Files some importer reads. Everything else that is not private is stored, unread. */
const PARSED = new Set([
  "connections.csv",
  "messages.csv",
  "profile.csv",
  "positions.csv",
  "skills.csv",
  "savedjobalerts.csv",
  "invitations.csv",
  "notes.csv",
  "recommendations_received.csv",
  "recommendations_given.csv",
  "jobs/job seeker preferences.csv",
  "jobs/job applications.csv",
  "jobs/saved jobs.csv",
  "certifications.csv",
  "honors.csv",
  "projects.csv",
  "volunteering.csv",
  "organizations.csv",
  "publications.csv",
]);

/**
 * The role of one member, by its path inside the export (`Jobs/Saved Jobs.csv`). Null for
 * anything that is not a CSV: an export is all CSVs, and a stray `.DS_Store` or PDF someone
 * dropped in the folder is not part of it.
 */
export function linkedInExportRole(path: string): ExportFileRole | null {
  const p = path.replace(/^\/+/, "").toLowerCase();
  if (!p.endsWith(".csv")) return null;
  if (PRIVATE.some((re) => re.test(p))) return "private";
  return PARSED.has(p) ? "parsed" : "stored";
}

/**
 * A member's path inside the export, given the folder (or ZIP directory) the export sits in.
 * `root` is where Connections.csv / messages.csv were found; `dir` is the member's own folder.
 */
export function exportRelativePath(root: string, dir: string, name: string): string {
  const sub = dir === root ? "" : root === "" ? dir : dir.slice(root.length + 1);
  return sub ? `${sub}/${name}` : name;
}

/** Whether `dir` is the export root or a folder inside it (LinkedIn nests `Jobs/`). */
export function isInsideExport(root: string, dir: string): boolean {
  return dir === root || root === "" || dir.startsWith(`${root}/`);
}
