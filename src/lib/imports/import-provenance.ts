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

/**
 * The fields a fingerprint covers: the identifying ones, and the scalar profile fields a person
 * edits by hand. Named as the `contacts` columns are (camelCase), so the engine can hash the
 * persisted row it got back from the insert without a mapping that could drift.
 *
 * Every field here must be one that NO system process rewrites after an import — a field the
 * avatar backfill or an enrichment job touched would make its people read "edited" and undo
 * would quietly remove nobody. That is why `profileImageUrl` (the avatar backfill writes it),
 * the closeness/priority scores (materialised by the scorer) and `aiSummary`/`keyFacts` (the
 * brief and message-enrichment writers) are absent. Checked for these five when they were
 * added (Sep 2026): every writer of `location`, `school`, `phone`, `website` and `x_handle`
 * after an import is a person acting — the contact form, capture, the extension's save, the
 * MCP `update_contact` tool, the "Refresh from LinkedIn" button, a merge, or a later import
 * the person ran — never a background job.
 */
export type FingerprintInput = {
  fullName?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  location?: string | null;
  school?: string | null;
  phone?: string | null;
  website?: string | null;
  xHandle?: string | null;
};

/** The payload key a staged row carries its provenance under. */
export const PROVENANCE_KEY = "importedBy";

/**
 * Order is part of the hash, and so is membership: changing either invalidates every stored
 * fingerprint, and a person whose stamp no longer matches reads "edited" — kept, so the failure
 * is safe, but it makes every import stamped before the change un-undoable. Widened from five
 * fields to ten before anything shipped, which is the only moment that costs nothing.
 */
const FIELDS: (keyof FingerprintInput)[] = [
  "fullName",
  "company",
  "title",
  "email",
  "linkedinUrl",
  "location",
  "school",
  "phone",
  "website",
  "xHandle",
];

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function fingerprintContact(input: FingerprintInput): string {
  // A separator no field can contain, so "ab" + "" can never collide with "a" + "b".
  const joined = FIELDS.map((f) => normalize(input[f])).join("\u0000");
  return createHash("sha256").update(joined).digest("hex").slice(0, 32);
}
