import type { LinkedInImportRowPayload } from "@/db/schema";
import type { ImportAdapter } from "@/lib/import-engine";
import { parseConnectedOn } from "@/lib/linkedin-connections";

/** Defined in a leaf module so the every-page LinkedIn reminder can read it cheaply. */
export { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-import-types";

export const linkedinConnectionsAdapter: ImportAdapter<LinkedInImportRowPayload> = {
  identity(payload) {
    const fullName = `${payload.firstName} ${payload.lastName}`.trim();
    if (!fullName) return null;
    return {
      fullName,
      email: payload.email,
      linkedinUrl: payload.url,
      company: payload.company,
      title: payload.position,
    };
  },

  toCreate(payload) {
    const connectedOn = parseConnectedOn(payload.connectedOn || "");
    return {
      fullName: `${payload.firstName} ${payload.lastName}`.trim(),
      firstName: payload.firstName,
      lastName: payload.lastName,
      company: payload.company || undefined,
      title: payload.position || undefined,
      email: payload.email || undefined,
      linkedinUrl: payload.url || undefined,
      source: "linkedin",
      // No statedCloseness: nobody has rated these people, and saying "2 out of 5" about
      // two thousand strangers is exactly the assumption this omission removes.
      // `contactInsertValues` coalesces `input.relationshipScore ?? 2`, so the legacy
      // column still reads 2 — which is precisely why `resolveStatedStrength` refuses to
      // treat a 2 as an assessment.
      firstInteractionAt: connectedOn ?? undefined,
      dateMet: connectedOn,
      howMet: "LinkedIn connection",
      metContext: "online",
      tagNames: ["linkedin"],
    };
  },

  toMerge(payload) {
    const connectedOn = parseConnectedOn(payload.connectedOn || "");
    return {
      company: payload.company || undefined,
      title: payload.position || undefined,
      email: payload.email || undefined,
      linkedinUrl: payload.url || undefined,
      firstName: payload.firstName || undefined,
      lastName: payload.lastName || undefined,
      source: "linkedin",
      dateMet: connectedOn || undefined,
      howMet: "LinkedIn connection",
      metContext: "online",
    };
  },
};
