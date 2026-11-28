import Papa from "papaparse";

/**
 * Cells a spreadsheet would evaluate as a formula (CSV injection, CWE-1236, audit INJ-CSV).
 * Waitlist names, referrers, UTM tags and feedback text are typed by anyone, so every string
 * cell starting with one of these gets Papa's `'` prefix. Papa's own default
 * (`/^[=+\-@\t\r].*$/`) misses a multi-line cell — `.` stops at the newline and `$` needs the
 * end of the string — so only the first character is tested. Numbers are not strings, so a
 * negative count is left alone.
 */
const CSV_FORMULA_START = /^[=+\-@\t\r]/;

/** CSV for a person to open in a spreadsheet: formula-looking cells read as text. */
export function toSpreadsheetCsv(rows: readonly object[]): string {
  return Papa.unparse(rows as object[], { escapeFormulae: CSV_FORMULA_START });
}
