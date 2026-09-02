/**
 * Reads a CSV out of a plain `.csv` upload or a LinkedIn export ZIP. Both the Connections
 * and Messages importers hand this the same File and a pattern for the entry they want —
 * LinkedIn ships one ZIP shape and splits large archives into "Part 1", "Part 2", etc., so
 * the entry can live at the ZIP root or nested under a part folder.
 *
 * Client-safe: imported by "use client" components, so no `@/db` or `next/*` imports here.
 * Also imported directly by tsx smoke scripts, so nothing here may assume a browser or a
 * Next.js runtime. `jszip` is imported dynamically so the client bundle only pays for it
 * when a ZIP actually shows up.
 */

export const CONNECTIONS_ENTRY = /(^|\/)connections\.csv$/i;
export const MESSAGES_ENTRY = /(^|\/)messages\.csv$/i;

export async function readCsvFromArchive(
  file: File,
  opts: { entryPattern: RegExp; fallbackName: string; missingMessage: string }
): Promise<{ text: string; fileName: string; siblingCsvs: string[] }> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".zip")) {
    return { text: await file.text(), fileName: file.name, siblingCsvs: [] };
  }

  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const csvFiles = Object.values(zip.files).filter(
    (f) => !f.dir && /\.csv$/i.test(f.name)
  );
  const entry = csvFiles.find((f) => opts.entryPattern.test(f.name));

  if (!entry) {
    const csvNames = csvFiles.map((f) => f.name.split("/").pop() || f.name);
    throw new Error(
      `${opts.missingMessage} This ZIP has: ${csvNames.join(", ") || "no CSV files"}. LinkedIn splits big archives into parts — Connections is usually in Part 1.`
    );
  }

  const text = await entry.async("string");
  const siblingCsvs = csvFiles
    .filter((f) => f !== entry)
    .map((f) => f.name.split("/").pop() || f.name);

  return {
    text,
    fileName: entry.name.split("/").pop() || opts.fallbackName,
    siblingCsvs,
  };
}
