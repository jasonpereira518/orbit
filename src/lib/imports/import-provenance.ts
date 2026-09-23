import { createHash } from "node:crypto";

/**
 * What an import remembers about a contact it wrote, so an undo can be exact rather than
 * inferred.
 *
 * `created` separates the people the import brought into existence from the ones it merged
 * into — only the former can be undone. `fp` is a fingerprint of the identifying fields it
 * wrote: if the contact still hashes the same, nobody has edited it since.
 *
 * Why a fingerprint at all: Orbit keeps no per-contact edit trail, and `contacts.updated_at`
 * cannot stand in for one — `avatar-backfill.ts` and `contact-brief.ts` write to imported
 * contacts minutes later and bump it, so it reads "touched" for nearly everyone.
 */
export type ImportedContactProvenance = { created: boolean; fp?: string };

export type FingerprintInput = {
  fullName?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
};

/** The payload key a staged row carries its provenance under. */
export const PROVENANCE_KEY = "importedBy";

/** Order is part of the hash: changing it invalidates every stored fingerprint. */
const FIELDS: (keyof FingerprintInput)[] = [
  "fullName",
  "company",
  "title",
  "email",
  "linkedinUrl",
];

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function fingerprintContact(input: FingerprintInput): string {
  // A separator no field can contain, so "ab" + "" can never collide with "a" + "b".
  const joined = FIELDS.map((f) => normalize(input[f])).join("\u0000");
  return createHash("sha256").update(joined).digest("hex").slice(0, 32);
}
