import Papa from "papaparse";

/**
 * Characters that spreadsheet applications (Excel, Google Sheets, Calc) treat as formula triggers.
 * Any text cell beginning with =, +, -, @, tab, or carriage return gets escaped with a leading single quote.
 */
export const CSV_FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Serializes objects or tabular rows into CSV format with formula injection protection enabled.
 */
export function safeUnparseCsv(
  rows: unknown[] | Papa.UnparseObject<unknown>,
  options?: Papa.UnparseConfig
): string {
  return Papa.unparse(rows, {
    escapeFormulae: CSV_FORMULA_START,
    ...options,
  });
}
