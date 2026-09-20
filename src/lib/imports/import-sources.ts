/**
 * Every `imports.import_type` Orbit writes, and what a person would call it.
 *
 * Pure and table-shaped so `scripts/smoke-import-sources.ts` can hold it against the adapter
 * constants. That guard exists because this drifted once already: the row used to print the
 * raw type (`google_contacts · 12 created`) for any type the list had not been taught, and
 * `outlook_recruiter_scan` arrived later and rendered as a bare "Import".
 */
export const IMPORT_SOURCE_LABEL: Record<string, string> = {
  linkedin_connections: "LinkedIn connections",
  linkedin_messages: "LinkedIn messages",
  contacts_file: "Contacts file",
  google_contacts: "Google Contacts",
  outlook_contacts: "Outlook Contacts",
  gmail_recruiter_scan: "Gmail recruiter scan",
  outlook_recruiter_scan: "Outlook recruiter scan",
  calendar_ics: "Calendar (.ics)",
  calendar_csv: "Calendar (CSV)",
};

/** A type this list has never heard of still gets a row that looks like the others. */
export const UNKNOWN_SOURCE_LABEL = "Import";

export function importSourceLabel(
  importType: string | null | undefined,
): string {
  if (!importType) return UNKNOWN_SOURCE_LABEL;
  return IMPORT_SOURCE_LABEL[importType] ?? UNKNOWN_SOURCE_LABEL;
}

/** Imports that log meetings onto existing contacts rather than creating anybody. */
export function createsContacts(
  importType: string | null | undefined,
): boolean {
  return importType !== "calendar_ics" && importType !== "calendar_csv";
}
