/**
 * GitHub identity for the extension, server side.
 *
 * `githubLogin` below is mirrored byte-for-byte in the extension's
 * `extension/src/inject/dom/url.ts`, and both run the same vectors
 * (`extension/test/vectors/identity.json`), so the two cannot quietly disagree
 * about who a GitHub profile belongs to.
 */

/**
 * Paths on github.com that look like a login but are GitHub's own pages.
 * Also the reason `githubLogin` can't simply take the first path segment.
 */
const GITHUB_RESERVED = new Set([
  "about", "account", "apps", "codespaces", "collections", "contact", "copilot",
  "customer-stories", "dashboard", "enterprise", "events", "explore", "features",
  "issues", "join", "login", "logout", "marketplace", "new", "notifications",
  "orgs", "organizations", "pricing", "pulls", "readme", "search", "security",
  "settings", "signup", "site", "sponsors", "team", "topics", "trending",
]);

/**
 * Reduce a GitHub profile URL, "@login" or bare login to a lowercase login, or
 * "" when it isn't one. GitHub logins are 1–39 characters of letters, digits
 * and single hyphens, never starting or ending with one.
 */
export function githubLogin(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const fromUrl = trimmed.match(/(?:^|\/\/|\.)github\.com\/([^/?#\s]+)/i);
  const raw = fromUrl ? fromUrl[1] : trimmed.replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(raw)) return "";
  const login = raw.toLowerCase();
  return GITHUB_RESERVED.has(login) ? "" : login;
}
