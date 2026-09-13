import { randomUUID } from "node:crypto";
import { identityKeysFor, linkedinSlug, nameSimilarity } from "@/lib/duplicates";
import type { OutreachIdentityKind } from "@/lib/outreach/types";

/**
 * Identity for generation-2 Outreach. Deliberately built ON `identityKeysFor` rather than
 * beside it: `outreach_identities` and `contact_identities` store the same normalized values,
 * so "already in your contacts" is an equality probe, not a second matcher (spec §5.3).
 */
export type OutreachIdentity = { kind: OutreachIdentityKind; value: string };

const PROFILE_PATH = /linkedin\.com\/in\/[^/?#]+/i;

export function isLinkedinProfileUrl(url: string | null | undefined): boolean {
  return Boolean(url && PROFILE_PATH.test(url));
}

export function canonicalLinkedinUrl(url: string | null | undefined): string | null {
  if (!isLinkedinProfileUrl(url)) return null;
  const slug = linkedinSlug(url);
  return slug ? `https://www.linkedin.com/in/${slug}` : null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

export function outreachIdentitiesFor(input: {
  linkedinUrl?: string | null;
  email?: string | null;
  apolloId?: string | null;
}): OutreachIdentity[] {
  const keys: OutreachIdentity[] = [];
  for (const key of identityKeysFor({
    // `linkedinSlug` turns ANY string into something; only real profile URLs may become identities.
    linkedinUrl: isLinkedinProfileUrl(input.linkedinUrl) ? input.linkedinUrl : null,
    email: normalizeEmail(input.email),
  })) {
    if (key.kind === "linkedin_slug" || key.kind === "email") keys.push({ kind: key.kind, value: key.value });
  }
  const apollo = input.apolloId?.trim();
  if (apollo) keys.push({ kind: "apollo", value: apollo });
  // Same (kind, value) order identityKeysFor promises: concurrent upserts touching two identities
  // in opposite orders would deadlock on the unique index's row locks.
  return keys.sort((x, y) =>
    x.kind === y.kind ? (x.value < y.value ? -1 : 1) : x.kind < y.kind ? -1 : 1
  );
}

const EXTERNAL_PREFIX: Record<OutreachIdentityKind, string> = {
  linkedin_slug: "li",
  apollo: "apollo",
  email: "email",
};

/** The strongest identity becomes `outreach_prospects.external_id` (spec §5.2). */
export function externalIdFor(identities: OutreachIdentity[]): string {
  for (const kind of ["linkedin_slug", "apollo", "email"] as const) {
    const found = identities.find((i) => i.kind === kind);
    if (found) return `${EXTERNAL_PREFIX[kind]}:${found.value}`;
  }
  return `manual:${randomUUID()}`;
}

function companyKey(company: string | null): string {
  return (company ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Name-only resemblance. Never grounds a merge — it produces `possible_duplicate_of` for a
 * person to review, because two people genuinely share names (spec §5.2).
 */
export function likelySamePerson(
  a: { fullName: string; company: string | null },
  b: { fullName: string; company: string | null }
): boolean {
  const sameCompany = companyKey(a.company) !== "" && companyKey(a.company) === companyKey(b.company);
  return sameCompany && nameSimilarity(a.fullName, b.fullName) >= 0.92;
}
