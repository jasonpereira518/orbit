/**
 * What an unauthenticated call to a protected `/api/*` route gets from `src/proxy.ts`.
 *
 * It used to get Clerk's 307 to /sign-in. `fetch` follows redirects, so the caller received
 * the sign-in page as `text/html` with status 200 — and the chat stream client, having
 * checked only `res.ok`, parsed HTML as SSE and spun forever (audit B1). A JSON 401 is
 * something every client can recognise.
 *
 * Import-free on purpose: the proxy and the smoke scripts both import it.
 */
export const API_SIGNED_OUT_STATUS = 401;

export const API_SIGNED_OUT_BODY = {
  error: "You’re signed out — sign in again",
  code: "signed_out",
} as const;

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}
