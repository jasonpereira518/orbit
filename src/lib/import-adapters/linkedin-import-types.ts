import { LINKEDIN_EXPORT_IMPORT_TYPE } from "@/lib/linkedin-export-type";

/**
 * The `imports.import_type` values LinkedIn import jobs carry.
 *
 * A leaf module on purpose: `linkedin-reminder.ts` runs in the (app) layout on every page,
 * and importing these from the adapters pulled the messages adapter's whole graph (the
 * timeline backfill, `ai.ts`, the relationship engine) into every signed-in route's cold
 * start. The adapters re-export them, so existing imports are unchanged.
 */
export const LINKEDIN_IMPORT_TYPE = "linkedin_connections";
export const LINKEDIN_MESSAGES_IMPORT_TYPE = "linkedin_messages";

/**
 * Every upload that counts as "LinkedIn brought in": either file on its own, or the whole
 * export. The status line, the refresh reminder and the bell all read this one list, so a
 * whole-export upload can't read "Not imported yet" in one place and fresh in another.
 */
export const LINKEDIN_UPLOAD_IMPORT_TYPES = [
  LINKEDIN_IMPORT_TYPE,
  LINKEDIN_MESSAGES_IMPORT_TYPE,
  LINKEDIN_EXPORT_IMPORT_TYPE,
] as const;
