import { useSyncExternalStore } from "react";

/**
 * Whether this browser looks signed in to Orbit, read from Clerk's own cookie without
 * loading Clerk.
 *
 * The marketing pages in `(site)` deliberately mount no ClerkProvider, which is the whole
 * point of them, so `useAuth()` is not available there. What IS available is
 * `__client_uat`: the "client updated at" cookie clerk-js keeps on the app's domain so the
 * server can tell signed-in from signed-out at the edge. Clerk writes `"0"` for a
 * signed-out client and a Unix timestamp otherwise (see `Cookies.ClientUat` in
 * @clerk/backend). Current Clerk also writes a suffixed twin, `__client_uat_<hash>`,
 * keyed to the publishable key, so both spellings count.
 *
 * This is a HINT, not authentication, and it is only ever used to pick which buttons to
 * show. A stale positive (signed out on another device, session expired) costs nothing:
 * "Open app" leads to the middleware, which sends the visitor to sign-in.
 */

const CLIENT_UAT = /^__client_uat(?:_[A-Za-z0-9_-]+)?$/;

/** True when any `__client_uat` cookie, suffixed or not, holds a positive timestamp. */
export function hasClerkSessionHint(cookie: string): boolean {
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (!CLIENT_UAT.test(part.slice(0, eq).trim())) continue;
    const value = part.slice(eq + 1).trim();
    if (/^\d+$/.test(value) && Number(value) > 0) return true;
  }
  return false;
}

// Nothing to subscribe to: the cookie only changes on sign-in or sign-out, both of which
// happen on other pages. Reading it once per render is enough.
const subscribe = () => () => {};
const readHint = () => hasClerkSessionHint(document.cookie);
const serverHint = () => false;

/**
 * The hint as React state. `false` on the server and during hydration, so the first frame
 * matches the static HTML every visitor is served, then the real value. That is the same
 * first frame as when this waited on Clerk, and it resolves sooner.
 */
export function useClerkSessionHint(): boolean {
  return useSyncExternalStore(subscribe, readHint, serverHint);
}
