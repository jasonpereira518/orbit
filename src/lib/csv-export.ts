import Papa from "papaparse";

/**
 * CSV for a person to open in a spreadsheet. `escapeFormulae` prefixes a cell starting with
 * = + - @ (or a tab or carriage return) with a quote, so Excel, Sheets and Numbers show it as
 * text instead of running it (audit INJ-CSV): names, companies and notes are typed by users
 * and by anyone who joins the waitlist, and `=HYPERLINK(...)` in a name is a working exploit.
 * Every CSV Orbit generates goes through here.
 */
export function toSpreadsheetCsv(rows: readonly object[]): string {
  return Papa.unparse(rows as object[], { escapeFormulae: true });
}
