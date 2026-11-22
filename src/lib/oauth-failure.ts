/** A provider-specific rule tried after the shared ones and before the `other` fallback. */
export type OAuthFailureRule = readonly [pattern: RegExp, kind: string];

/** Gmail and Outlook: the userinfo / Graph profile lookup after the token exchange failed. */
export const PROFILE_FETCH_RULE: OAuthFailureRule = [/profile|no email/i, "profile_fetch_failed"];

/** Eventbrite: the account has no organization to attach events to. */
export const NO_ORGANIZATION_RULE: OAuthFailureRule = [/organization/i, "no_organization"];

/**
 * Keeps `error_events.kind` low-cardinality so the admin console can group on it.
 * The first three rules are shared by every OAuth callback; each provider adds its own
 * after them (order matters: the shared rules win).
 */
export function classifyOAuthFailure(err: unknown, ...extraRules: OAuthFailureRule[]): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/authorization code/i.test(message)) return "missing_code";
  if (/OAuth state|does not match/i.test(message)) return "state_mismatch";
  if (/Token exchange/i.test(message)) return "token_exchange_failed";
  for (const [pattern, kind] of extraRules) if (pattern.test(message)) return kind;
  return "other";
}
