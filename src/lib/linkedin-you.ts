/**
 * The four members of a LinkedIn export that describe YOU rather than other people:
 * Profile.csv, Positions.csv, Skills.csv and SavedJobAlerts.csv.
 *
 * Pure parsers, no I/O. Everything comes out cleaned (`cleanSingleLine`) and capped, because
 * these strings are later pasted into model prompts and rendered next to other people's data.
 *
 * Profile.csv carries a birth date, a street address and a zip code. They are never read: a
 * parser cannot leak a column it does not touch, and nothing here has a use for them.
 */
import Papa from "papaparse";
import { cleanSingleLine } from "@/lib/ai-security";
import { csvGet, LinkedInExportError } from "@/lib/linkedin-connections";
import {
  looksLikeLinkedInAlerts,
  looksLikeLinkedInPositions,
  looksLikeLinkedInProfile,
  looksLikeLinkedInSkills,
} from "@/lib/linkedin-you-shape";
import type { CareerProfile } from "@/db/schema";

export const MAX_SKILLS = 100;
export const MAX_ROLE_KEYWORDS = 10;
const TERM_MAX = 60;
const LINE_MAX = 200;
const SUMMARY_MAX = 600;

export type LinkedInProfileFields = NonNullable<CareerProfile["profile"]>;

function rowsOf(text: string): { fields: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: true,
  });
  return { fields: (parsed.meta.fields ?? []).map((f) => f.trim().toLowerCase()), rows: parsed.data };
}

/** Case-insensitive de-duplication that keeps the first spelling. */
function uniqueTerms(values: (string | null)[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Headline, summary, industry and location. Never the name, address, birth date or zip. */
export function parseLinkedInProfileCsv(text: string): LinkedInProfileFields {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInProfile(fields) || !rows.length) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's Profile.csv.");
  }
  const row = rows[0];
  const out: LinkedInProfileFields = {};
  const headline = cleanSingleLine(csvGet(row, "Headline"), LINE_MAX);
  const industry = cleanSingleLine(csvGet(row, "Industry"), LINE_MAX);
  const location = cleanSingleLine(csvGet(row, "Geo Location"), LINE_MAX);
  const summary = cleanSingleLine(csvGet(row, "Summary"), SUMMARY_MAX);
  if (headline) out.headline = headline;
  if (industry) out.industry = industry;
  if (location) out.location = location;
  if (summary) out.summary = summary;
  if (!Object.keys(out).length) {
    throw new LinkedInExportError("That Profile.csv has no headline, summary, industry or location to import.");
  }
  return out;
}

/**
 * The role you hold now: the first row with no end date. LinkedIn lists newest first, so the
 * first open-ended row is the current one. Null when every role has ended.
 */
export function parseLinkedInPositionsCsv(text: string): { title: string; company: string } | null {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInPositions(fields)) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's Positions.csv.");
  }
  for (const row of rows) {
    if (csvGet(row, "Finished On")) continue;
    const title = cleanSingleLine(csvGet(row, "Title"), LINE_MAX);
    const company = cleanSingleLine(csvGet(row, "Company Name"), LINE_MAX);
    if (title && company) return { title, company };
  }
  return null;
}

export function parseLinkedInSkillsCsv(text: string): string[] {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInSkills(fields)) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's Skills.csv.");
  }
  const skills = uniqueTerms(rows.map((r) => cleanSingleLine(csvGet(r, "Name"), TERM_MAX)), MAX_SKILLS);
  if (!skills.length) throw new LinkedInExportError("That Skills.csv is empty.");
  return skills;
}

/**
 * The job titles you have alerts for.
 *
 * `QUERY_CONTEXT` is a Java-style map string, not JSON, and everything in it but `keywords=` is
 * unusable: locations are numeric geo ids with no place name and there is no company field. So
 * this reads that one key and ignores the rest, rather than parsing a format nobody documents.
 */
export function parseLinkedInAlertsCsv(text: string): string[] {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInAlerts(fields)) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's SavedJobAlerts.csv.");
  }
  const found = rows.map((r) => {
    const query = csvGet(r, "QUERY_CONTEXT");
    const m = /(?:^|[{,\s])keywords=([^,}]*)/.exec(query);
    return m ? cleanSingleLine(m[1], TERM_MAX) : null;
  });
  return uniqueTerms(found, MAX_ROLE_KEYWORDS);
}
