/**
 * What may leave the building in a data export.
 *
 * A pure module rather than a helper inside `actions/settings.ts`, because a `"use server"`
 * file may only export async actions — so the redaction could not be imported by a test, and
 * the one guarantee it makes was unverifiable. `scripts/smoke-settings-export.ts` now drives
 * it from the schema, the way `smoke-purge.ts` drives purge coverage.
 */
import { userSettings } from "@/db/schema";

/**
 * Every credential column on `user_settings`, by name.
 *
 * `satisfies` is what makes this list honest: rename or drop one of these columns and the
 * build fails here. The previous version destructured them out of a value cast to
 * `Record<string, unknown>`, which erased exactly the type that was supposed to be doing the
 * checking — and its comment claimed that "a new secret column added later should break this
 * function's type", which was never true in either direction. Destructuring known keys does
 * not complain when a key is ADDED; a new secret column simply rode out in the export.
 */
export const REDACTED_SETTINGS_COLUMNS = [
  "geminiApiKeyEncrypted",
  "openaiApiKeyEncrypted",
  "anthropicApiKeyEncrypted",
  "apolloApiKeyEncrypted",
  "resendApiKeyEncrypted",
  "twilioAccountSidEncrypted",
  "twilioAuthTokenEncrypted",
  "calendarFeedToken",
] satisfies readonly (keyof typeof userSettings.$inferSelect)[];

/**
 * Columns whose NAME looks like a credential but which carry no secret.
 *
 * Kept explicit so the backstop below stays fail-closed: anything credential-shaped is
 * dropped unless it appears here, and adding to this list is a deliberate act with a reason
 * attached rather than a silent omission.
 */
export const CREDENTIAL_SHAPED_BUT_SAFE = new Set<string>([
  // When the feed token was minted. The token itself is redacted above; the timestamp is
  // ordinary account history and belongs in an export of your own data.
  "calendarFeedTokenCreatedAt",
]);

/** Names that read as a secret: `...ApiKeyEncrypted`, `...Token`, `...Secret`, `...Sid`. */
export const CREDENTIAL_NAME = /(secret|token|apikey|encrypted|sid)$/i;

/**
 * Strip every credential from a settings row before it leaves the building.
 *
 * Two mechanisms, because the named list alone is a promise that someone will remember.
 * `REDACTED_SETTINGS_COLUMNS` is the deliberate list and is type-checked against the table.
 * The name-shaped sweep is the backstop: a column added later and called
 * `stripeSecretEncrypted` is dropped whether or not anyone thought to add it here, which is
 * what the old comment promised and did not deliver. `user_settings` is 58 columns wide and
 * growing, so an exhaustive allowlist would be its own maintenance trap; this fails closed
 * on the shape that matters.
 *
 * Deliberately NOT a general allowlist: `/settings`'s export is "everything we hold about
 * you", and a new column of the user's own content silently missing from it is the failure
 * Phase 3 set out to fix.
 */
export function redactSettingsForExport<T extends Record<string, unknown>>(row: T) {
  const redacted = new Set<string>(REDACTED_SETTINGS_COLUMNS);
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) =>
        !redacted.has(key) &&
        (!CREDENTIAL_NAME.test(key) || CREDENTIAL_SHAPED_BUT_SAFE.has(key))
    )
  );
}