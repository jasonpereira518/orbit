/**
 * One search box, several kinds of input. Turns what a person pastes into the identifiers
 * the who-knows-whom lookup can match — with the SAME normalisers `identityKeysFor` uses to
 * write `contact_identities`, or the equality probe would miss. Pure and client-safe.
 */
import { linkedinSlug, normalizePhone, normalizeXHandle } from "@/lib/duplicates";
import { displayCompanyName, normalizeCompanyName } from "@/lib/company-name";
import type { TargetIdentity } from "./warm-path";

export type ParsedTarget = TargetIdentity & {
  displayName: string | null;
  kind: "email" | "linkedin" | "phone" | "x" | "name_company" | "name" | "empty";
};

const EMPTY: ParsedTarget = { displayName: null, kind: "empty" };

export function parseTargetInput(raw: string): ParsedTarget {
  const s = raw.trim();
  if (!s) return EMPTY;
  if (/linkedin\.com\/in\//i.test(s)) {
    const slug = linkedinSlug(s);
    return slug ? { linkedinSlug: slug, displayName: null, kind: "linkedin" } : EMPTY;
  }
  if (s.includes("@") && !s.startsWith("@") && !/\s/.test(s)) {
    return { email: s.toLowerCase(), displayName: null, kind: "email" };
  }
  if (s.startsWith("@") && !/\s/.test(s)) {
    const handle = normalizeXHandle(s);
    return handle ? { xHandle: handle, displayName: null, kind: "x" } : EMPTY;
  }
  const digits = s.replace(/[\s().-]/g, "");
  if (/^\+?\d{7,15}$/.test(digits)) {
    const phone = normalizePhone(s);
    return phone ? { phoneE164: phone, displayName: null, kind: "phone" } : EMPTY;
  }
  const comma = s.indexOf(",");
  if (comma > 0) {
    const name = s.slice(0, comma).trim();
    const company = s.slice(comma + 1).trim();
    return {
      displayName: name || null,
      companyNormalized: company ? normalizeCompanyName(displayCompanyName(company)) : null,
      kind: "name_company",
    };
  }
  return { displayName: s, kind: "name" };
}
