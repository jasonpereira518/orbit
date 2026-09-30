/**
 * Public social handles a person adds to a contact, for Radar's post signals. Pure and
 * client-safe, so the contact form and the writer normalize the same way.
 *
 * Accepts what people paste (`@name.bsky.social`, a profile URL, `@user@host`), stores one
 * canonical form, and returns null for anything that is not a handle at all, so a typo
 * never becomes a request to some host.
 */

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** "name.bsky.social", "@Name.bsky.social", or "https://bsky.app/profile/name.bsky.social". */
export function normalizeBlueskyHandle(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim().toLowerCase();
  const m = v.match(/^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/?#]+)/);
  if (m) v = m[1]!;
  v = v.replace(/^@/, "");
  if (v.length > 253 || !DOMAIN.test(v)) return null;
  return v;
}

/** "user@host", "@user@host", or "https://host/@user". Stored as "user@host". */
export function normalizeMastodonAcct(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim();
  const url = v.match(/^https?:\/\/([^/?#]+)\/@([A-Za-z0-9_]+)\/?$/);
  if (url) v = `${url[2]}@${url[1]}`;
  v = v.replace(/^@/, "");
  const m = v.match(/^([A-Za-z0-9_]{1,64})@([^@\s]+)$/);
  if (!m) return null;
  const host = m[2]!.toLowerCase();
  if (host.length > 253 || !DOMAIN.test(host)) return null;
  return `${m[1]}@${host}`;
}
