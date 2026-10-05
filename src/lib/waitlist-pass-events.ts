/**
 * The one-way channel from the join form to the rest of the page: "this visitor now has a
 * pass, and here is its token".
 *
 * The hero sets `?me=` with `history.replaceState`, which does not re-render server
 * components, so anything server-fed (the feature poll) never learns the token. A DOM event
 * carries it across without coupling the components. Same shape as `starfield-events.ts`.
 *
 * No React, no `next/*` imports: this file is safe to load from anywhere.
 */
export const WAITLIST_PASS_EVENT = "waitlist:pass";

/** Announce the visitor's pass token. No-op on the server. */
export function announcePass(token: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(WAITLIST_PASS_EVENT, { detail: token }));
}

/** Subscribe to pass announcements; returns the unsubscribe function. */
export function onPass(listener: (token: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const token = (e as CustomEvent<string>).detail;
    if (typeof token === "string" && token) listener(token);
  };
  window.addEventListener(WAITLIST_PASS_EVENT, handler);
  return () => window.removeEventListener(WAITLIST_PASS_EVENT, handler);
}
