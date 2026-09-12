/**
 * URL canonicalization.
 *
 * The regexes here MUST stay byte-identical to `linkedinSlug` and
 * `normalizeXHandle` in the Orbit app's src/lib/duplicates.ts. If they drift,
 * matching fails silently — the extension confidently reports "new to your
 * orbit" for someone the user has known for years, which is the single worst
 * failure this product can have. Any change to one is a change to both.
 */

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "miniProfileUrn",
  "lipi",
  "licu",
  "trk",
  "trkInfo",
  "originalSubdomain",
  "original_referer",
  "refId",
  "rcm",
  "s",
  "t",
  "ref_src",
  "ref_url",
];

export function stripTracking(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
    url.hash = "";
    return url.toString().replace(/\?$/, "");
  } catch {
    return rawUrl;
  }
}

/**
 * Mirrors `linkedinSlug` in the app. Returns "" when there is no /in/ segment
 * (the app falls back to the whole string there; we treat it as "no signal"
 * and let the caller decide).
 *
 * Deliberately does NOT percent-decode. The app compares raw captures, so
 * decoding here would turn a stored `/in/jos%C3%A9` and a live `/in/josé` into
 * a mismatch. Both sides stay byte-identical by both doing nothing.
 */
export function linkedinSlug(url: string | null | undefined): string {
  if (!url) return "";
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Fold locale and mobile subdomains, sub-routes, and query strings down to the
 * one canonical profile URL. `/in/foo/details/experience` and
 * `de.linkedin.com/in/foo?x=1` are the same person.
 */
export function canonicalLinkedInUrl(url: string): string | null {
  const slug = linkedinSlug(url);
  return slug ? `https://www.linkedin.com/in/${slug}` : null;
}

/**
 * LinkedIn's opaque `ACoAAB…` identifiers are stable enough to match on but
 * useless to show a human, so the popup falls back to the extracted name.
 */
export function isOpaqueSlug(slug: string): boolean {
  return /^acoa[a-z0-9_-]{10,}$/i.test(slug);
}

/** Mirrors `normalizeXHandle` in the app. */
export function xHandle(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const fromUrl = trimmed.match(
    /(?:^|\/\/|\.)(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i
  );
  const raw = fromUrl ? fromUrl[1] : trimmed.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(raw) ? raw.toLowerCase() : "";
}

/** Paths on x.com that look like handles but aren't people. */
const X_RESERVED = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "bookmarks",
  "jobs",
  "settings",
  "compose",
  "search",
  "i",
  "intent",
  "login",
  "logout",
  "signup",
  "tos",
  "privacy",
  "about",
  "download",
  "hashtag",
]);

export function isReservedXPath(handle: string): boolean {
  return X_RESERVED.has(handle.toLowerCase());
}

/**
 * Whether a link is an actual X profile URL.
 *
 * `xHandle` stays byte-identical to the app's normalizeXHandle (see the header),
 * which is deliberately loose because it also parses handles a user typed by
 * hand. That looseness is wrong for scanning links on an arbitrary page: a real
 * page yielded `help.x.com/en/using-x/...`, which parses to the "handle" `en`.
 * So link scanning goes through this stricter host check instead.
 */
export function isXProfileUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (!/^((www|mobile)\.)?(x|twitter)\.com$/i.test(url.hostname)) return false;
    const first = url.pathname.split("/").filter(Boolean)[0] ?? "";
    const handle = xHandle(first);
    return Boolean(handle) && !isReservedXPath(handle);
  } catch {
    return false;
  }
}
