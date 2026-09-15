/**
 * The legal pages' shared facts, DB-free so the marketing pages, onboarding and smoke tests
 * can all import them.
 *
 * TERMS_VERSION is what `user_settings.terms_version` records at acceptance. Change it (and
 * LEGAL_LAST_UPDATED) in the same commit as any material change to /terms or /privacy.
 */
export const TERMS_VERSION = "2026-09-15";
export const LEGAL_LAST_UPDATED = "September 15, 2026";

/**
 * Clerk's `legal_accepted_at` from a user.created payload, as an acceptance to record.
 * Clerk timestamps are unix epochs whose unit varies by field; anything below 1e12 is read
 * as seconds (the same rule as `epochToDate` in user-settings.ts).
 */
export function termsAcceptanceFromClerk(
  legalAcceptedAt: number | null | undefined
): { acceptedAt: Date; version: string } | null {
  if (typeof legalAcceptedAt !== "number" || !Number.isFinite(legalAcceptedAt) || legalAcceptedAt <= 0) {
    return null;
  }
  const ms = legalAcceptedAt < 1e12 ? legalAcceptedAt * 1000 : legalAcceptedAt;
  return { acceptedAt: new Date(ms), version: TERMS_VERSION };
}

/** True when this account has not accepted the current Terms. */
export function needsTermsAcceptance(termsVersion: string | null | undefined): boolean {
  return termsVersion !== TERMS_VERSION;
}
