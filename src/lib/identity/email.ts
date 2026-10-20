/**
 * The one email normalizer (plan P4.3). Trim + lowercase; `null` for null/undefined/blank AND
 * for anything without an `@`, so a stray word never becomes a match key. Never throws.
 *
 * This is the form `contact_identities` stores for `kind = 'email'`. A `null` result means
 * "no email": callers skip the lookup instead of inventing an error.
 */
export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  return trimmed;
}
