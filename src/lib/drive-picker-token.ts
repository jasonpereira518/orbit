import { grantCovers } from "@/lib/google-scopes";

/**
 * Why `getDrivePickerToken` (`src/actions/drive.ts`) can't hand back a Picker token for this
 * connection, decided from the row alone — no DB, no network — so it's smoke-testable
 * without a user session. `null` means the grant is usable and the caller should go fetch
 * a live access token.
 */
export function pickerTokenReason(
  conn: { status: string; scopes: string | null } | undefined,
): "not_connected" | "needs_reconnect" | "needs_consent" | null {
  if (!conn) return "not_connected";
  // Mirrors `previewGoogleContacts` (src/actions/imports.ts): a lapsed connection keeps its
  // scopes on the row, so checking `grantCovers` first would read a dead grant as usable.
  if (conn.status !== "active") return "needs_reconnect";
  if (!grantCovers("drive", conn.scopes)) return "needs_consent";
  return null;
}
