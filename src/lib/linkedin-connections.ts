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

function csvGet(row: Record<string, string>, ...keys: string[]) {
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

export function parseLinkedInConnectionsCsv(csvText: string): {
  columns: string[];
  rows: LinkedInConnectionRow[];
} {
  const text = stripLinkedInConnectionsPreamble(csvText);
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(parsed.errors[0]?.message || "Failed to parse CSV");
  }

  const rows = parsed.data
    .map(mapLinkedInConnectionRow)
    .filter((r) => r.firstName || r.lastName);

  if (!rows.length) {
    const fields = (parsed.meta.fields || [])
      .map((f) => f.trim())
      .filter(Boolean);
    const hint = fields.length
      ? ` Found columns: ${fields.slice(0, 8).join(", ")}.`
      : "";
    throw new Error(
      `No connections found in CSV. Export Connections from LinkedIn (not Messages).${hint}`
    );
  }

  return {
    columns: parsed.meta.fields || [],
    rows,
  };
}
