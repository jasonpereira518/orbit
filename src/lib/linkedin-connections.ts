import Papa from "papaparse";

export type LinkedInConnectionRow = {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
  url: string;
};

/** Case/whitespace-insensitive column lookup across LinkedIn CSV header variants. */
export function csvGet(row: Record<string, string>, ...keys: string[]) {
  for (const k of keys) {
    const found = Object.entries(row).find(
      ([key]) => key.trim().toLowerCase() === k.toLowerCase()
    );
    if (found?.[1]) return found[1].trim();
  }
  return "";
}

export function mapLinkedInConnectionRow(
  row: Record<string, string>
): LinkedInConnectionRow {
  return {
    firstName: csvGet(row, "First Name", "first name", "FirstName"),
    lastName: csvGet(row, "Last Name", "last name", "LastName"),
    email: csvGet(row, "Email Address", "Email", "email"),
    company: csvGet(row, "Company", "company"),
    position: csvGet(row, "Position", "Title", "position"),
    connectedOn: csvGet(row, "Connected On", "connected on"),
    url: csvGet(row, "URL", "LinkedIn URL", "Profile URL", "url"),
  };
}

/**
 * LinkedIn Connections.csv usually starts with a Notes: preamble before the
 * real header row. Skip that so Papa uses First Name / Last Name as columns.
 */
export function stripLinkedInConnectionsPreamble(csvText: string): string {
  const text = csvText.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes("first name") &&
      lower.includes("last name") &&
      (lower.includes("connected on") ||
        lower.includes("company") ||
        lower.includes("url"))
    );
  });
  if (headerIdx > 0) {
    return lines.slice(headerIdx).join("\n");
  }
  return text;
}

/** Header fields that only appear in a Messages.csv export, never Connections.csv. */
const MESSAGES_ONLY_FIELDS = [
  "conversation id",
  "conversation title",
  "from",
  "to",
  "content",
];

function looksLikeMessagesExport(fields: string[]) {
  const lower = fields.map((f) => f.trim().toLowerCase());
  const hasNameFields = lower.includes("first name") && lower.includes("last name");
  if (hasNameFields) return false;
  return MESSAGES_ONLY_FIELDS.filter((f) => lower.includes(f)).length >= 2;
}

/**
 * The inverse, for the Messages card: a Connections.csv has name columns and a
 * "Connected On" date, and never a conversation id.
 */
export function looksLikeConnectionsExport(fields: string[]) {
  const lower = fields.map((f) => f.trim().toLowerCase());
  return (
    lower.includes("first name") &&
    lower.includes("last name") &&
    lower.includes("connected on") &&
    !lower.includes("conversation id")
  );
}

/**
 * A LinkedIn export the parser refused, with a message written for the person who picked
 * the file — which is the one thing the preview actions forward to the toast. Anything
 * else a parser throws is a bug (or PapaParse's own wording, "Unable to auto-detect
 * delimiting character"), and gets the generic copy instead. Same split as
 * `ContactsFileError` in `src/lib/contacts-file.ts`.
 */
export class LinkedInExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedInExportError";
  }
}

/**
 * Parse LinkedIn "Connected On" values.
 * Handles:
 * - "15 Jan 2024", "01/15/2024" (text exports)
 * - Excel/Sheets serial day numbers like "46198" (CSV re-saved from a spreadsheet)
 */
export function parseConnectedOn(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  // Spreadsheet serial dates (days since 1899-12-30). Modern LinkedIn
  // connections land roughly in 30000–80000 (≈1990–2100).
  if (/^\d{4,6}(\.\d+)?$/.test(value)) {
    const serial = Number(value);
    if (serial >= 30000 && serial <= 80000) {
      const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
      const fromSerial = new Date(ms);
      if (!Number.isNaN(fromSerial.getTime())) return fromSerial.toISOString();
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  // Bare numerics like "46198" become year 46198 in JS Date — reject those.
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;

  return parsed.toISOString();
}

export function parseLinkedInConnectionsCsv(csvText: string): {
  columns: string[];
  rows: LinkedInConnectionRow[];
  warnings: string[];
} {
  if (!csvText.trim().length) {
    throw new LinkedInExportError("That file is empty");
  }

  const text = stripLinkedInConnectionsPreamble(csvText);
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length && !parsed.data.length) {
    // PapaParse's own wording is for developers; say what to do instead.
    throw new LinkedInExportError(
      "Couldn’t read that file as a CSV — download Connections.csv from LinkedIn again and upload it as it is"
    );
  }

  const fields = (parsed.meta.fields || []).map((f) => f.trim()).filter(Boolean);

  if (looksLikeMessagesExport(fields)) {
    throw new LinkedInExportError(
      "This looks like a Messages export, not Connections — upload it on the Messages tab instead"
    );
  }

  const rows = parsed.data
    .map(mapLinkedInConnectionRow)
    .filter((r) => r.firstName || r.lastName);

  if (!rows.length) {
    const hint = fields.length ? ` (it has ${fields.slice(0, 8).join(", ")})` : "";
    throw new LinkedInExportError(
      `No connections found in that file${hint} — export Connections from LinkedIn, not Messages`
    );
  }

  const warnings: string[] = [];
  if (parsed.errors.length) {
    // Not "skipped": PapaParse keeps a row with too few or too many columns, and it is
    // imported like any other as long as it has a name. What is true is that some of its
    // fields may have landed in the wrong column.
    warnings.push(
      `${parsed.errors.length} row${parsed.errors.length === 1 ? "" : "s"} had an unexpected number of columns — ${parsed.errors.length === 1 ? "that person" : "those people"} may have a company or title in the wrong field, so check them after importing.`
    );
  }

  return {
    columns: fields,
    rows,
    warnings,
  };
}
