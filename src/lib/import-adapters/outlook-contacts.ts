import type { OutlookContactRowPayload } from "@/db/schema";
import type { ImportAdapter } from "@/lib/import-engine";

/**
 * The `imports.import_type` value Outlook Contacts import jobs carry.
 *
 * Lives here rather than in `import-job-dispatch.ts` (which re-exports it, so every
 * existing call site is unchanged) so the adapter registry can key on it without importing
 * the dispatcher — the dispatcher reaches the engine, and the engine reaches the registry.
 */
export const OUTLOOK_CONTACTS_IMPORT_TYPE = "outlook_contacts";

/**
 * Same identity story as Google Contacts (see `google-contacts.ts`): Outlook contacts are
 * matched on email, and a row with no email still probes on `fullName` alone, matchable only
 * on the weak `byName` tier (0.6 confidence, below the 0.85 merge floor) — so it creates
 * rather than merges, deliberately, rather than risk merging two different same-named
 * people on no stronger evidence.
 */
export const outlookContactsAdapter: ImportAdapter<OutlookContactRowPayload> = {
  identity(payload) {
    if (!payload.fullName.trim()) return null;
    return {
      fullName: payload.fullName,
      email: payload.email,
      company: payload.company,
      title: payload.title,
    };
  },

  toCreate(payload) {
    return {
      fullName: payload.fullName,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      company: payload.company || undefined,
      title: payload.title || undefined,
      email: payload.email || undefined,
      phone: payload.phone || undefined,
      source: "outlook_contacts",
      // Kept explicit even though `contactInsertValues` coalesces `input.relationshipScore
      // ?? 2` to the same value — this task changes plumbing only, not the semantics of
      // this field.
      relationshipScore: 2,
      howMet: "Outlook Contacts",
      metContext: "online",
      tagNames: ["outlook-contacts"],
    };
  },

  toMerge(payload) {
    return {
      company: payload.company || undefined,
      title: payload.title || undefined,
      email: payload.email || undefined,
      phone: payload.phone || undefined,
      source: "outlook_contacts",
      howMet: "Outlook Contacts",
      metContext: "online",
    };
  },
};
