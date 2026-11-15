/**
 * The members of a LinkedIn export that describe YOU rather than other people:
 * Profile.csv, Positions.csv, Skills.csv, SavedJobAlerts.csv and Education.csv.
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
  looksLikeLinkedInEducation,
  looksLikeLinkedInPositions,
  looksLikeLinkedInProfile,
  looksLikeLinkedInSkills,
} from "@/lib/linkedin-you-shape";
import type { CareerEducation, CareerPosition, CareerProfile, CareerYearMonth } from "@/db/schema";

export const MAX_SKILLS = 100;
export const MAX_POSITIONS = 50;
export const POSITION_DESCRIPTION_MAX = 500;
export const MAX_ROLE_KEYWORDS = 10;
/** `setSchools` keeps ten, at most 120 characters each. */
export const MAX_SCHOOLS = 10;
const SCHOOL_MAX = 120;
const TERM_MAX = 60;
const LINE_MAX = 200;
/** LinkedIn's own headline limit, so an imported headline is never cut short. */
export const HEADLINE_MAX = 220;
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

/** The schools on the user's profile, in LinkedIn's order. Degrees, dates and notes are not read. */
export function parseLinkedInEducationCsv(text: string): string[] {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInEducation(fields)) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's Education.csv.");
  }
  const schools = uniqueTerms(
    rows.map((r) => cleanSingleLine(csvGet(r, "School Name"), SCHOOL_MAX)),
    MAX_SCHOOLS,
  );
  if (!schools.length) throw new LinkedInExportError("That Education.csv lists no schools.");
  return schools;
}

/** Headline, summary, industry and location. Never the name, address, birth date or zip. */
export function parseLinkedInProfileCsv(text: string): LinkedInProfileFields {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInProfile(fields) || !rows.length) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's Profile.csv.");
  }
  const row = rows[0];
  const out: LinkedInProfileFields = {};
  const headline = cleanSingleLine(csvGet(row, "Headline"), HEADLINE_MAX);
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

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * A LinkedIn date cell. The export writes "May 2026" for roles and "2020" for schools; a
 * 4-digit year anywhere gives the year, and an English month name or its 3-letter short form
 * before it gives the month. Anything else ("Present", "", a translated month) gives no month,
 * or no date at all. Never `Date.parse`: it reads "2020" as a UTC instant and "May" as nothing.
 */
export function parseLinkedInYearMonth(raw: string | undefined): CareerYearMonth | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  const y = /\b(\d{4})\b/.exec(s);
  if (!y) return undefined;
  const year = Number(y[1]);
  if (year < 1900 || year > 2100) return undefined;
  const word = /([a-z]+)\.?\s*$/.exec(s.slice(0, y.index).trim())?.[1];
  const idx = word ? MONTHS.findIndex((m) => m === word || m.slice(0, 3) === word) : -1;
  return idx >= 0 ? { year, month: idx + 1 } : { year };
}

/** Every role in Positions.csv, past and current, in file order (LinkedIn writes newest first). */
export function parseLinkedInPositionHistoryCsv(text: string): CareerPosition[] {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInPositions(fields)) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's Positions.csv.");
  }
  const out: CareerPosition[] = [];
  for (const row of rows) {
    const title = cleanSingleLine(csvGet(row, "Title"), LINE_MAX);
    const company = cleanSingleLine(csvGet(row, "Company Name"), LINE_MAX);
    if (!title || !company) continue;
    const p: CareerPosition = { title, company };
    const start = parseLinkedInYearMonth(csvGet(row, "Started On"));
    const end = parseLinkedInYearMonth(csvGet(row, "Finished On"));
    const location = cleanSingleLine(csvGet(row, "Location"), LINE_MAX);
    const description = cleanSingleLine(csvGet(row, "Description"), POSITION_DESCRIPTION_MAX);
    if (start) p.start = start;
    if (end) p.end = end;
    if (location) p.location = location;
    if (description) p.description = description;
    out.push(p);
    if (out.length >= MAX_POSITIONS) break;
  }
  return out;
}

/** Every school in Education.csv with its degree and years. Notes and Activities are not read. */
export function parseLinkedInEducationHistoryCsv(text: string): CareerEducation[] {
  const { fields, rows } = rowsOf(text);
  if (!looksLikeLinkedInEducation(fields)) {
    throw new LinkedInExportError("That doesn't look like LinkedIn's Education.csv.");
  }
  const out: CareerEducation[] = [];
  for (const row of rows) {
    const school = cleanSingleLine(csvGet(row, "School Name"), SCHOOL_MAX);
    if (!school) continue;
    const e: CareerEducation = { school };
    const degree = cleanSingleLine(csvGet(row, "Degree Name"), LINE_MAX);
    const start = parseLinkedInYearMonth(csvGet(row, "Start Date"));
    const end = parseLinkedInYearMonth(csvGet(row, "End Date"));
    if (degree) e.degree = degree;
    if (start) e.start = start;
    if (end) e.end = end;
    out.push(e);
    if (out.length >= MAX_SCHOOLS) break;
  }
  return out;
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
