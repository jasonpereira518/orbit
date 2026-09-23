/**
 * What the browser was in the middle of connecting, carried across a full-page OAuth trip.
 *
 * Connecting a provider leaves the app entirely — `createExternalAccount` hands back the
 * provider's URL and the browser navigates to it — so nothing in React survives to the return
 * leg. Without a note, the callback route cannot tell a link that took from a consent the
 * person refused, and so cannot say anything truthful about either.
 *
 * `sessionStorage` rather than a query parameter: the callback URL is handed to the provider,
 * which is free to append to it, and it lands in history and in server logs. Same origin, same
 * tab, gone when the tab closes.
 *
 * Every access is wrapped: storage throws in a private window and when site data is blocked.
 * A lost note only costs the confirmation line, never the connection itself, so failing quiet
 * is right here.
 */
const KEY = "orbit.pending-connect";

export type PendingConnect = {
  /** The provider slug, as `providerKey` normalises it. */
  provider: string;
  /** What to call it in a confirmation — "Google", not "oauth_google". */
  label: string;
};

/** Written immediately before navigating away, so a failed request leaves no note behind. */
export function rememberPendingConnect(pending: PendingConnect): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Storage blocked. The return leg falls back to saying nothing.
  }
}

/** Reads the note and clears it, so one round trip reports itself once. */
export function takePendingConnect(): PendingConnect | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { provider, label } = parsed as { provider?: unknown; label?: unknown };
    if (typeof provider !== "string" || typeof label !== "string") return null;
    if (provider.length === 0 || label.length === 0) return null;
    return { provider, label };
  } catch {
    return null;
  }
}
