"use server";

import { after } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import { getValidAccessToken } from "@/lib/gmail";
import { asActionResult, friendlyError, ReauthRequiredError, type ActionResult } from "@/lib/errors";
import { runDriveImportJob, stageDriveImport } from "@/lib/drive-import-processor";
import { removeDriveFlag } from "@/lib/drive-flags";
import { pickerTokenReason } from "@/lib/drive-picker-token";
import type { PickedDriveFile } from "@/lib/imports/drive-triage";

/**
 * A short-lived Google token for the Picker, which runs in the browser and cannot use the
 * encrypted token we store. Only ever for a grant that covers drive.file, so what reaches
 * the browser can open the Picker and nothing more. Returned as data, never thrown: a thrown
 * message is replaced by a digest in production.
 */
export async function getDrivePickerToken(): Promise<
  | { ok: true; accessToken: string }
  | { ok: false; reason: "needs_consent" | "not_connected" | "needs_reconnect" | "error"; error?: string }
> {
  const userId = await requireSyncUser();
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { scopes: true, status: true },
  });
  const reason = pickerTokenReason(conn);
  if (reason) return { ok: false, reason };
  try {
    return { ok: true, accessToken: await getValidAccessToken(userId, { minValidityMs: 10 * 60_000 }) };
  } catch (err) {
    // The refresh token itself was rejected mid-flight (revoked, or Google now wants fresh
    // consent) even though the row still read `active` a moment ago — same fix as a lapsed
    // row: send the person to reconnect rather than a transient-sounding "try again".
    if (err instanceof ReauthRequiredError) return { ok: false, reason: "needs_reconnect" };
    return { ok: false, reason: "error", error: friendlyError(err, "Couldn’t reach Google — try again in a moment") };
  }
}

/**
 * Stage the picked files and start reading them in the background.
 *
 * `stageDriveImport` raises `UserFacingError` ("Pick up to 25 files at a time", "Pick a
 * Google Doc or Slides deck to import"), and a message thrown across the "use server"
 * boundary is replaced by an opaque digest in production. So — unlike the plain-`Error`
 * `start*` imports in `src/actions/imports.ts` — this follows the `asActionResult` sibling
 * group (`account.ts`, `gmail.ts`, `outlook.ts`, …), which returns a `UserFacingError`'s
 * message as data instead of throwing it. Task 8 unwraps the `ActionResult` client-side.
 */
export async function startDriveImport(
  files: PickedDriveFile[],
): Promise<ActionResult<{ importId: string; totalRows: number }>> {
  // Outside the wrap: a denied entitlement throws `PaywallError`, not `UserFacingError`, so
  // `asActionResult` would just rethrow it anyway — no point wrapping it.
  const userId = await requireSyncUser();
  return asActionResult(async () => {
    const staged = await stageDriveImport(userId, files);
    after(() => runDriveImportJob(staged.importId).catch(() => {}));
    return staged;
  });
}

/**
 * Drop a flagged commitment from an import's "Worth a look" list.
 *
 * `requireUserId`, not `requireSyncUser`: this only touches an import the caller already
 * owns (`removeDriveFlag` re-checks that), so it doesn't need the paid `sync` entitlement
 * re-verified — dismissing a flag on a past import shouldn't lock out someone who has since
 * moved off the plan that let them run it.
 */
export async function dismissDriveFlag(importId: string, flagId: string): Promise<void> {
  const userId = await requireUserId();
  await removeDriveFlag(userId, importId, flagId);
}
