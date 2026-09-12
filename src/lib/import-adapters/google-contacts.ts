import type { GoogleContactRowPayload } from "@/db/schema";
import type { ImportAdapter } from "@/lib/import-engine";

/**
 * The `imports.import_type` value Google Contacts import jobs carry.
 *
 * Lives here rather than in `import-job-dispatch.ts` (which re-exports it, so every
 * existing call site is unchanged) so the adapter registry can key on it without importing
 * the dispatcher — the dispatcher reaches the engine, and the engine reaches the registry.
 */
export const GOOGLE_CONTACTS_IMPORT_TYPE = "google_contacts";

/**
 * Google Contacts identity is keyed on email, not a LinkedIn URL — the People API gives no
 * stable per-connection URL, and email is what the old per-row `findDuplicateCandidates`
 * call actually probed here. A row with no email at all (common — many Google contacts have
 * only a name and phone) still gets a `fullName` probe, so `findDuplicateCandidatesIndexed`
 * can still match it on the weak `byName` tier (0.6 confidence) — below the 0.85 merge
 * floor, so it creates rather than merges. That's a deliberate, not accidental, choice: a
 * name-only row has nothing else to key a confident merge on, and creating is strictly
 * safer than silently merging two different people who happen to share a name.
 */
export const googleContactsAdapter: ImportAdapter<GoogleContactRowPayload> = {
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
      profileImageUrl: payload.photoUrl || undefined,
      source: "google_contacts",
      // Kept explicit even though `contactInsertValues` coalesces `input.relationshipScore
      // ?? 2` to the same value — this task changes plumbing only, not the semantics of
      // this field.
      relationshipScore: 2,
      howMet: "Google Contacts",
      metContext: "online",
      tagNames: ["google-contacts"],
    };
  },

  toMerge(payload) {
    return {
      company: payload.company || undefined,
      title: payload.title || undefined,
      email: payload.email || undefined,
      phone: payload.phone || undefined,
      profileImageUrl: payload.photoUrl || undefined,
      source: "google_contacts",
      howMet: "Google Contacts",
      metContext: "online",
    };
  },
};
