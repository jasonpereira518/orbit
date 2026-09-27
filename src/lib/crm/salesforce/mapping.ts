/**
 * Salesforce, pure: the scopes and fields Orbit asks for, which hosts a token may be sent to,
 * the SOQL a sync runs, the keyset progress it carries across runs, and what a record becomes.
 *
 * Built on REST API v66.0. `instance_url` and the identity URL arrive in a token response;
 * both are checked with `isTrustedSalesforceUrl` before a bearer token goes near them.
 */

/** A token response names the org's host; nothing outside these domains is ever sent a token. */
export const SALESFORCE_HOST_SUFFIXES = ["salesforce.com", "force.com", "cloudforce.com"] as const;

export function isTrustedSalesforceUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    return SALESFORCE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}
