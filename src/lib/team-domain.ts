/**
 * What makes a team, without a database: the domain rule and the names shown for people
 * on one. Pure and client-safe — the join card and the warm-path chips import it.
 */
import { publicEmailDomain } from "@/lib/closeness-evidence";

/**
 * Written into `teams.created_by` when the creator's account is purged. Same word as
 * `RECRUITER_DELETED_CREATOR`, for the same reason: never null, never a dangling id.
 */
export const TEAM_DELETED_CREATOR = "deleted-account";

/**
 * The team a verified email belongs to, or null when it cannot form one: no address, no
 * dot in the host, or a public mailbox provider (nobody at gmail.com is a colleague of
 * everybody else at gmail.com).
 */
export function teamDomainForEmail(email: string | null | undefined): string | null {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".") || /[\s/]/.test(domain)) return null;
  if (publicEmailDomain(domain)) return null;
  return domain;
}

/** Second-level labels that are a registry, not a company: `acme.co.uk` is Acme. */
const GENERIC_SECOND_LEVELS = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** A display name for a team, from its domain: `eu.acme.com` → "Acme". */
export function teamNameForDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  let label = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? domain);
  if (parts.length >= 3 && GENERIC_SECOND_LEVELS.has(label)) label = parts[parts.length - 3];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * How a teammate is named in a lookup result. Accounts that predate the Clerk mirror have
 * null first/last names in `user_settings` (see the `firstName` comment in schema.ts), so
 * the mailbox name is the fallback, and a neutral word after that.
 */
export function teammateDisplayName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const full = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  if (full) return full;
  const mailbox = row.email?.split("@")[0]?.trim();
  return mailbox || "A teammate";
}
