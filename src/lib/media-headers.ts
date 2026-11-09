/**
 * Response headers for the routes that serve a user's media from Orbit's own origin:
 * contact avatars, capture photos, feedback screenshots and stored import files (audit L-09).
 *
 * `Cross-Origin-Resource-Policy: same-origin` tells the browser not to hand these bytes to a
 * page on another origin that embeds them (`<img src="https://orbit…/api/capture/photos/…">`
 * on an attacker's site would otherwise load with the victim's cookie, and side channels such
 * as image dimensions or timing would leak something about a private photo). Every legitimate
 * consumer is same-origin: the app's own pages. The browser extension never loads these
 * routes — `/api/extension/contacts` sends it absolute https photo URLs instead, because the
 * extension is a different origin — so `same-origin` breaks nothing.
 *
 * Set on every response the routes return, redirects and misses included, so no branch is
 * forgotten.
 */
export const MEDIA_CORP_HEADER = "Cross-Origin-Resource-Policy";
export const MEDIA_CORP_VALUE = "same-origin";

export function withMediaResourcePolicy<T extends Response>(res: T): T {
  try {
    res.headers.set(MEDIA_CORP_HEADER, MEDIA_CORP_VALUE);
    return res;
  } catch {
    // A response with immutable headers (`Response.redirect`): copy it with the header added.
    const headers = new Headers(res.headers);
    headers.set(MEDIA_CORP_HEADER, MEDIA_CORP_VALUE);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers }) as T;
  }
}
