/**
 * Pure encode/decode for the Gmail OAuth `state` parameter — no DB, no Next imports, so
 * this module can be exercised directly by a tsx smoke script.
 *
 * Format: `userId:nonce:encodeURIComponent(returnTo):scopes` — exactly four ":"-separated
 * fields. `returnTo` is percent-encoded specifically so a colon inside it (e.g. a query
 * string like `?x=a:b`) can never be mistaken for a field separator.
 */
import type { GoogleScopeSet } from "./gmail";

const SCOPE_SETS: readonly GoogleScopeSet[] = ["contacts", "mailbox"];

function isGoogleScopeSet(value: string): value is GoogleScopeSet {
  return (SCOPE_SETS as readonly string[]).includes(value);
}

export function encodeGmailOAuthState(opts: {
  userId: string;
  nonce: string;
  returnTo: string;
  scopes: GoogleScopeSet;
}): string {
  return `${opts.userId}:${opts.nonce}:${encodeURIComponent(opts.returnTo)}:${opts.scopes}`;
}

/**
 * Returns null for anything malformed — wrong field count, missing userId/nonce, an
 * unrecognized scope set, or an unparseable percent-encoding. Callers must fail closed on
 * null (treat it as a state mismatch) rather than default to any particular scope set.
 */
export function decodeGmailOAuthState(state: string): {
  userId: string;
  nonce: string;
  returnTo: string;
  scopes: GoogleScopeSet;
} | null {
  const parts = state.split(":");
  if (parts.length !== 4) return null;
  const [userId, nonce, encodedReturnTo, scopes] = parts;
  if (!userId || !nonce) return null;
  if (!isGoogleScopeSet(scopes)) return null;

  let returnTo = "";
  if (encodedReturnTo) {
    try {
      returnTo = decodeURIComponent(encodedReturnTo);
    } catch {
      return null;
    }
  }

  return { userId, nonce, returnTo, scopes };
}
