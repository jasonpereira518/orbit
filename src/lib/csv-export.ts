import Papa from "papaparse";

/**
 * CSV for a person to open in a spreadsheet. `escapeFormulae` prefixes a cell starting with
 * = + - @ (or a tab or carriage return) with a quote, so Excel, Sheets and Numbers show it as
 * text instead of running it (audit INJ-CSV): names, companies and notes are typed by users
 * and by anyone who joins the waitlist, and `=HYPERLINK(...)` in a name is a working exploit.
 * Every CSV Orbit generates goes through here.
 */
export function toSpreadsheetCsv(rows: readonly object[]): string {
  return Papa.unparse(rows as object[], { escapeFormulae: CSV_FORMULA_START });
}

/**
 * Only the first character is tested. Papa's own default (`/^[=+\-@\t\r].*$/`) misses a
 * multi-line cell: `.` stops at the newline and `$` needs the end of the string. Numbers are
 * not strings, so a negative count is left alone.
 */
const CSV_FORMULA_START = /^[=+\-@\t\r]/;
