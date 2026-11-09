/**
 * How a lead is written. Its identifiers come from the SAME `identityKeysFor` that writes
 * `contact_identities`, so a teammate's contact matches a lead by plain equality in the
 * warm-path SQL — two normalisers would drift, and a drifted email is a lead nobody "knows".
 * Pure and client-safe.
 */
import { identityKeysFor, type IdentityKind } from "@/lib/duplicates";
import { displayCompanyName, normalizeCompanyName } from "@/lib/company-name";
import type { TargetIdentity } from "./warm-path";

export type LeadInput = {
  displayName: string;
  email?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
  companyName?: string | null;
  title?: string | null;
};

export type NormalizedLead = {
  displayName: string;
  email: string | null;
  emailNormalized: string | null;
  linkedinUrl: string | null;
  linkedinSlug: string | null;
  phone: string | null;
  phoneE164: string | null;
  companyName: string | null;
  companyNormalized: string | null;
  title: string | null;
};

/** Longest a free-text lead field may be: a pasted profile is not a name. */
export const LEAD_FIELD_MAX = 200;

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().slice(0, LEAD_FIELD_MAX);
  return trimmed ? trimmed : null;
}

export function normalizeLeadInput(input: LeadInput): NormalizedLead {
  const email = clean(input.email);
  const linkedinUrl = clean(input.linkedinUrl);
  const phone = clean(input.phone);
  const keys = identityKeysFor({ email, linkedinUrl, phone });
  const pick = (kind: IdentityKind) => keys.find((k) => k.kind === kind)?.value ?? null;
  const company = clean(input.companyName);
  const companyName = company ? displayCompanyName(company) || null : null;
  return {
    displayName: clean(input.displayName) ?? "",
    email,
    emailNormalized: pick("email"),
    linkedinUrl,
    linkedinSlug: pick("linkedin_slug"),
    phone,
    phoneE164: pick("phone_e164"),
    companyName,
    companyNormalized: companyName ? normalizeCompanyName(companyName) || null : null,
    title: clean(input.title),
  };
}

/** A lead posted from the client, kept to the fields and types a lead has. */
export function coerceLeadInput(raw: unknown): LeadInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    displayName: text(r.displayName) ?? "",
    email: text(r.email),
    linkedinUrl: text(r.linkedinUrl),
    phone: text(r.phone),
    companyName: text(r.companyName),
    title: text(r.title),
  };
}

/** The identifiers a stored lead contributes to a warm-path lookup. */
export function leadTargetIdentity(lead: {
  emailNormalized: string | null;
  linkedinSlug: string | null;
  phoneE164: string | null;
  companyNormalized: string | null;
}): TargetIdentity {
  return {
    email: lead.emailNormalized,
    linkedinSlug: lead.linkedinSlug,
    phoneE164: lead.phoneE164,
    companyNormalized: lead.companyNormalized,
  };
}
