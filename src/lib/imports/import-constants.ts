/**
 * Import constants with no dependencies, so the /imports page can read them without pulling
 * `detect-import-file` and `contacts-file` (papaparse and the parsers) into its first load.
 * Both originals re-export these, so every other importer is unchanged.
 */
import { IMPORT_TEXT_MAX_BYTES } from "@/lib/capture-limits";
import type { ImportTarget } from "@/lib/imports/detect-import-file";

/**
 * The order imports run in, regardless of the order files were dropped.
 *
 * Connections before messages is not cosmetic. The messages preview matches conversation
 * partners against contacts that already exist, so running messages first makes every partner
 * look new and does the deduplication backwards.
 */
export const RUN_ORDER: readonly ImportTarget[] = [
  "linkedin_connections",
  "contacts_file",
  "linkedin_messages",
  "linkedin_profile",
  "linkedin_positions",
  "linkedin_skills",
  "linkedin_alerts",
  "calendar_ics",
  "calendar_csv",
  // Last: its extras (invitations, notes, recommendations) attach to people, so the people
  // from Connections.csv must already be here.
  "linkedin_export",
];

/**
 * The largest contacts file the browser will even read.
 *
 * Deliberately far above `MAX_CONTACTS_FILE_CHARS`, because the raw file is not what gets
 * uploaded: an iCloud or Android export embeds every contact photo as base64, and a few hundred
 * photos is tens of megabytes of pixels around a few hundred kilobytes of names.
 * `compactContactsFileText` strips those in the browser before anything is sent, so this only
 * has to stop someone feeding `file.text()` something absurd.
 */
export const MAX_CONTACTS_FILE_BYTES = 50 * 1024 * 1024;

/**
 * The most bytes a dropped file of this kind may have before it is skipped. Contacts files
 * shrink in the browser (photos stripped); every other kind is sent as it is, so it has to
 * fit one request. A ZIP member is measured after unzipping.
 */
export function maxImportBytesFor(target: ImportTarget): number {
  return target === "contacts_file" ? MAX_CONTACTS_FILE_BYTES : IMPORT_TEXT_MAX_BYTES;
}
