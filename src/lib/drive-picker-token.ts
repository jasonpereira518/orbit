import { grantCovers } from "@/lib/google-scopes";

/**
 * Why `checkDriveReadiness` (`src/actions/drive.ts`) says the stored Google grant can't export
 * picked files yet, decided from the row alone — no DB, no network — so it's smoke-testable
 * without a user session. `null` means the grant covers `drive.file` and the caller should
 * confirm it still refreshes. (The Picker's own token never comes from this grant.)
 */
export function driveReadinessReason(
  conn: { status: string; scopes: string | null } | undefined,
): "not_connected" | "needs_reconnect" | "needs_consent" | null {
  if (!conn) return "not_connected";
  // Mirrors `previewGoogleContacts` (src/actions/imports.ts): a lapsed connection keeps its
  // scopes on the row, so checking `grantCovers` first would read a dead grant as usable.
  if (conn.status !== "active") return "needs_reconnect";
  if (!grantCovers("drive", conn.scopes)) return "needs_consent";
  return null;
}
