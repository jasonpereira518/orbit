import type { ImportJobRowPayload } from "@/db/schema";
import type { ImportAdapter } from "@/lib/import-engine";
import {
  LINKEDIN_IMPORT_TYPE,
  linkedinConnectionsAdapter,
} from "@/lib/import-adapters/linkedin-connections";
import {
  GOOGLE_CONTACTS_IMPORT_TYPE,
  googleContactsAdapter,
} from "@/lib/import-adapters/google-contacts";
import {
  OUTLOOK_CONTACTS_IMPORT_TYPE,
  outlookContactsAdapter,
} from "@/lib/import-adapters/outlook-contacts";
import {
  LINKEDIN_MESSAGES_IMPORT_TYPE,
  linkedinMessagesAdapter,
} from "@/lib/import-adapters/linkedin-messages";

/**
 * Every import type the engine can run, keyed by `imports.import_type`.
 *
 * `ImportAdapter`'s members are declared with method shorthand, so an adapter written
 * against its own narrow payload (e.g. `LinkedInImportRowPayload`) is assignable to the
 * union-typed entry here. The engine only ever hands an adapter rows from a job whose
 * `import_type` selected it, so the narrowing is sound by construction.
 */
const ADAPTERS: Record<string, ImportAdapter<ImportJobRowPayload>> = {
  [LINKEDIN_IMPORT_TYPE]: linkedinConnectionsAdapter,
  [GOOGLE_CONTACTS_IMPORT_TYPE]: googleContactsAdapter,
  [OUTLOOK_CONTACTS_IMPORT_TYPE]: outlookContactsAdapter,
  [LINKEDIN_MESSAGES_IMPORT_TYPE]: linkedinMessagesAdapter,
};

/**
 * Returns `null` for import types with no server-side runner — the client-driven kinds,
 * and the Gmail recruiter scan, which owns its own processor rather than feeding rows
 * through the contact create/merge loop.
 */
export function getAdapter(importType: string): ImportAdapter<ImportJobRowPayload> | null {
  return ADAPTERS[importType] ?? null;
}
