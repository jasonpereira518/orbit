/**
 * Turning a pasted or uploaded guest list into attendee rows.
 *
 * This is the acquisition path that actually covers the common case. No platform exposes the
 * guest list of an event you merely attended — Luma's API key is scoped to a calendar you own,
 * Eventbrite's attendees endpoint needs organiser scope, and Partiful hides the invite list
 * from guests by design. So for anything you did not host, the list arrives by copy-paste,
 * CSV, or a screenshot run through the existing capture extraction.
 *
 * Pure: no network, no DB, no AI. The screenshot path resolves to text upstream and lands here
 * as a paste, so all three inputs converge on one parser and one output shape.
 */
import Papa from "papaparse";
import { attendeeIdentityKey } from "@/lib/events/identity";

export type ParsedAttendee = {
  fullName: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  identityKey: string;
};

export type RosterParseResult = {
  attendees: ParsedAttendee[];
  /** Lines that carried nothing identifiable. Reported, never silently dropped. */
  skipped: number;
  /** Duplicate lines collapsed within this paste. */
  deduped: number;
};

/**
 * A room's worth of people, generously. Past this the input is a mistake — a whole CRM export
 * pasted into the wrong box — and accepting it would build a roster nobody can review.
 */
export const MAX_ROSTER_ROWS = 5_000;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const LINKEDIN = /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[^\s,;|]+/i;
const X_HANDLE = /(?:^|\s)@([A-Za-z0-9_]{2,15})(?:\s|$)/;

function clean(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, " ") ?? "";
  return text.length > 0 ? text : null;
}

/**
 * A name has to contain a letter.
 *
 * Pasted lists carry separator debris — "???", "---", "1.", a stray emoji — and without this
 * each one becomes an attendee keyed `nm:???` that the user then has to delete by hand. Kept
 * here rather than in `attendeeIdentityKey` because that function mirrors ingest's and must
 * stay identical to it; this is a property of messy paste input specifically.
 */
function personName(value: string | null | undefined): string | null {
  const text = clean(value);
  return text && /\p{L}/u.test(text) ? text : null;
}

/**
 * Strip a trailing job/company clause off a name.
 *
 * Guest lists are written for humans, so a line is routinely "Ada Lovelace — Engineer at
 * Analytical". Splitting on the separator gives a usable name and often a title/company for
 * free; leaving it would make the name unmatchable against an existing contact.
 */
function splitNameClause(raw: string): { name: string | null; rest: string | null } {
  const parts = raw.split(/\s+[–—|]\s+|\s+-\s+|\s*,\s*/);
  const name = personName(parts[0] ?? null);
  const rest = clean(parts.slice(1).join(", ") || null);
  return { name, rest };
}

/** "Engineer at Analytical" -> title + company. Either half may be absent. */
function splitRole(raw: string | null): { title: string | null; company: string | null } {
  if (!raw) return { title: null, company: null };
  const at = /^(.*?)\s+(?:at|@)\s+(.+)$/i.exec(raw);
  if (at) return { title: clean(at[1]), company: clean(at[2]) };
  return { title: null, company: raw };
}

function finalize(rows: Array<Omit<ParsedAttendee, "identityKey">>): RosterParseResult {
  const attendees: ParsedAttendee[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let deduped = 0;

  for (const row of rows.slice(0, MAX_ROSTER_ROWS)) {
    const identityKey = attendeeIdentityKey(row);
    if (!identityKey) {
      skipped++;
      continue;
    }
    if (seen.has(identityKey)) {
      deduped++;
      continue;
    }
    seen.add(identityKey);
    attendees.push({ ...row, identityKey });
  }
  return { attendees, skipped, deduped };
}

/**
 * Parse a pasted list, one person per line.
 *
 * Handles the shapes people actually paste: bare names, `Name <email>`, `Name, Company`,
 * `Name — Title at Company`, tab-separated columns off a web table, and LinkedIn URLs mixed
 * in. Anything unrecognisable is counted as skipped rather than guessed at.
 */
export function parseRosterText(text: string): RosterParseResult {
  const rows: Array<Omit<ParsedAttendee, "identityKey">> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // A leading bullet or list marker is noise from wherever this was copied.
    const body = line.replace(/^[-*•·\d]+[.)\]]?\s+/, "").trim();
    if (!body) continue;

    const email = clean(EMAIL.exec(body)?.[0] ?? null);
    const linkedinUrl = clean(LINKEDIN.exec(body)?.[0] ?? null);
    // Strip what we have already claimed so it cannot be mistaken for part of the name.
    let remainder = body;
    if (email) remainder = remainder.replace(email, " ");
    if (linkedinUrl) remainder = remainder.replace(linkedinUrl, " ");
    const xHandle = clean(X_HANDLE.exec(remainder)?.[1] ?? null);
    if (xHandle) remainder = remainder.replace(`@${xHandle}`, " ");
    // Angle brackets and separators left over from `Name <email>` shapes.
    remainder = remainder.replace(/[<>()]/g, " ").replace(/\s+/g, " ").trim();

    // Tabs mean this came off a table; treat the columns as name / role / company.
    const columns = rawLine.includes("\t")
      ? rawLine.split("\t").map((c) => clean(c))
      : null;

    if (columns && columns.filter(Boolean).length > 1) {
      const [rawName, second, third] = columns;
      const name = personName(rawName);
      const role = splitRole(second ?? null);
      rows.push({
        fullName: name,
        email,
        company: third ?? role.company,
        title: role.title ?? (third ? second ?? null : null),
        linkedinUrl,
        xHandle,
      });
      continue;
    }

    const { name, rest } = splitNameClause(remainder);
    const role = splitRole(rest);
    rows.push({
      fullName: name,
      email,
      company: role.company,
      title: role.title,
      linkedinUrl,
      xHandle,
    });
  }

  return finalize(rows);
}

/** Header aliases, lowercased. Covers Luma, Eventbrite and Partiful exports plus the obvious. */
const HEADERS: Record<keyof Omit<ParsedAttendee, "identityKey">, string[]> = {
  fullName: ["name", "full name", "attendee name", "guest name", "first name"],
  email: ["email", "email address", "e-mail", "attendee email"],
  company: ["company", "organization", "organisation", "employer", "company name"],
  title: ["title", "job title", "role", "position", "headline"],
  linkedinUrl: ["linkedin", "linkedin url", "linkedin profile", "profile url"],
  xHandle: ["x", "twitter", "x handle", "twitter handle"],
};

function pick(row: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const match = Object.keys(row).find((h) => h.trim().toLowerCase() === key);
    if (match) {
      const value = clean(row[match]);
      if (value) return value;
    }
  }
  return null;
}

/**
 * Parse a CSV export.
 *
 * Headers are matched by alias rather than position, so a Luma export and an Eventbrite one
 * both work without the user mapping columns by hand. A `First Name` / `Last Name` pair is
 * joined, because exports split them more often than not.
 */
export function parseRosterCsv(csvText: string): RosterParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length && parsed.data.length === 0) {
    throw new Error(parsed.errors[0]?.message || "Could not read that CSV.");
  }

  const rows = parsed.data.map((row) => {
    let fullName = personName(pick(row, HEADERS.fullName));
    const last = pick(row, ["last name", "surname", "family name"]);
    if (last && fullName && !fullName.includes(" ")) fullName = `${fullName} ${last}`;
    return {
      fullName,
      email: pick(row, HEADERS.email),
      company: pick(row, HEADERS.company),
      title: pick(row, HEADERS.title),
      linkedinUrl: pick(row, HEADERS.linkedinUrl),
      xHandle: pick(row, HEADERS.xHandle)?.replace(/^@/, "") ?? null,
    };
  });

  return finalize(rows);
}
