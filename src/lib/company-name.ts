/** Pure company-name helpers — safe for client bundles (no DB). */

export function normalizeCompanyName(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

export function displayCompanyName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * The key two organization names are compared on. Lives here rather than in `apollo.ts`
 * because `contact-profile-format.ts` and the contact page need it, and `apollo.ts`
 * imports `@/db` — which a client component may not transitively reach.
 */
export function normalizeCompanyKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
