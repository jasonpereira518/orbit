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
    throw new Error("That file is empty.");
  }

  const text = stripLinkedInConnectionsPreamble(csvText);
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(parsed.errors[0]?.message || "Failed to parse CSV");
  }

  const fields = (parsed.meta.fields || []).map((f) => f.trim()).filter(Boolean);

  if (looksLikeMessagesExport(fields)) {
    throw new Error(
      "This looks like a Messages export, not Connections. Use the Messages import below instead."
    );
  }

  const rows = parsed.data
    .map(mapLinkedInConnectionRow)
    .filter((r) => r.firstName || r.lastName);

  if (!rows.length) {
    // Three different situations used to share one sentence and one hint.
    //
    //   - A file that is not a CSV at all: `fields` is binary noise, and it was
    //     interpolated raw into the message — a real one read "Found columns:
    //     +KK4␓ll␁2C\uFFFDT\uFFFD\uFFFD\uFFFDf?..." where "this is not a CSV" was
    //     the thing worth saying.
    //   - The RIGHT export with no data rows: the columns named in the hint were
    //     perfectly correct, which made the error read as though they were the problem.
    //   - The wrong export (Messages instead of Connections).
    const recognised = fields.some((f) =>
      /first name|last name|email address|company|position/i.test(f)
    );

    if (!fields.length || !looksLikeTextColumns(fields)) {
      throw new Error(
        "That file doesn't look like a CSV. Export Connections from LinkedIn and upload the Connections.csv it gives you."
      );
    }
    if (recognised) {
      throw new Error(
        "That Connections.csv has the right columns but no people in it. Ask LinkedIn for a fresh export, or check you uploaded the full file."
      );
    }
    throw new Error(
      `No connections found in CSV. Export Connections from LinkedIn (not Messages). Found columns: ${fields
        .slice(0, 8)
        .map(printableColumn)
        .join(", ")}.`
    );
  }

  const warnings: string[] = [];
  if (parsed.errors.length) {
    warnings.push(
      `${parsed.errors.length} row${parsed.errors.length === 1 ? "" : "s"} could not be read and ${parsed.errors.length === 1 ? "was" : "were"} skipped.`
    );
  }

  return {
    columns: fields,
    rows,
    warnings,
  };
}

/**
 * Whether parsed header cells look like text a human wrote, rather than the byte soup a
 * binary file produces when Papa splits it on commas.
 */
function looksLikeTextColumns(fields: string[]): boolean {
  if (!fields.length) return false;

  // Control characters and replacement marks are a giveaway, but not a sufficient test:
  // arbitrary bytes decode to printable Latin-1 surprisingly often (0xd4 -> "Ô"), which
  // is how a 400KB binary file still produced a "Found columns:" hint. A real header cell
  // also contains ASCII letters and is mostly ordinary text.
  const wordish = fields.filter((f) => {
    const v = f.trim();
    if (!v || /[\u0000-\u0008\u000e-\u001f\uFFFD]/.test(v)) return false;
    if (!/[A-Za-z]/.test(v)) return false;
    const ordinary = v.replace(/[^A-Za-z0-9 _.'()\/-]/g, "").length;
    return ordinary / v.length >= 0.8;
  });

  return wordish.length >= Math.ceil(fields.length / 2);
}

/** Never let raw bytes reach a toast: control characters out, length capped. */
function printableColumn(field: string): string {
  const cleaned = field
    .replace(/[\u0000-\u001f\u007f\uFFFD]/g, "")
    .trim();
  if (!cleaned) return "?";
  return cleaned.length > 24 ? `${cleaned.slice(0, 23)}…` : cleaned;
}
