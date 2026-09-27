import { decryptOrNull } from "@/lib/crypto";

/**
 * Best-effort revocation of Orbit's Google grant. Deleting our row alone leaves the grant
 * listed (and usable with the stolen token) in the user's Google account. Never throws, and
 * gives up after five seconds: a deletion must not wait on Google.
 *
 * Microsoft has no equivalent: the identity platform offers no endpoint that revokes one
 * app's delegated refresh token, and `POST /me/revokeSignInSessions` signs the user out of
 * EVERY app. The Outlook disconnect dialog points the user at their Microsoft account
 * instead (Task 10).
 */
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const REVOKE_TIMEOUT_MS = 5_000;

export type RevokeResult = "revoked" | "already_invalid" | "skipped" | "error";

export async function revokeGoogleToken(
  token: string | null,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RevokeResult> {
  if (!token) return "skipped";
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REVOKE_TIMEOUT_MS),
    });
    if (res.ok) return "revoked";
    // Google answers 400 invalid_token for a token that is already revoked or expired.
    if (res.status === 400) return "already_invalid";
    return "error";
  } catch {
    return "error";
  }
}

/** Revoking the refresh token ends the whole grant; the access token is the fallback. */
export async function revokeGoogleGrant(
  row: { refreshTokenEncrypted: string | null; accessTokenEncrypted: string | null },
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RevokeResult> {
  const token = decryptOrNull(row.refreshTokenEncrypted) ?? decryptOrNull(row.accessTokenEncrypted);
  return revokeGoogleToken(token, opts);
}
