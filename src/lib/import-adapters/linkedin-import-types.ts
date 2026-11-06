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
