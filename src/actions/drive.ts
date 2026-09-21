"use server";

import { after } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import { grantCovers } from "@/lib/google-scopes";
import { getValidAccessToken } from "@/lib/gmail";
import { friendlyError } from "@/lib/errors";
import { runDriveImportJob, stageDriveImport } from "@/lib/drive-import-processor";
import { removeDriveFlag } from "@/lib/drive-flags";
import type { PickedDriveFile } from "@/lib/imports/drive-triage";

/**
 * A short-lived Google token for the Picker, which runs in the browser and cannot use the
 * encrypted token we store. Only ever for a grant that covers drive.file, so what reaches
 * the browser can open the Picker and nothing more. Returned as data, never thrown: a thrown
 * message is replaced by a digest in production.
 */
export async function getDrivePickerToken(): Promise<
  | { ok: true; accessToken: string }
  | { ok: false; reason: "needs_consent" | "not_connected" | "error"; error?: string }
> {
  const userId = await requireSyncUser();
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { scopes: true },
  });
  if (!conn) return { ok: false, reason: "not_connected" };
  if (!grantCovers("drive", conn.scopes)) return { ok: false, reason: "needs_consent" };
  try {
    return { ok: true, accessToken: await getValidAccessToken(userId, { minValidityMs: 10 * 60_000 }) };
  } catch (err) {
    return { ok: false, reason: "error", error: friendlyError(err, "Couldn’t reach Google — try again in a moment") };
  }
}

/**
 * Stage the picked files and start reading them in the background.
 *
 * Throws on a bad selection (too many files, nothing supported) — `stageDriveImport` raises
 * a `UserFacingError`, and sibling `start*` actions in `src/actions/imports.ts` (e.g.
 * `startLinkedInImport`) let that propagate rather than wrapping with `asActionResult`, so
 * this matches that shape. The caller (Task 8's `runServerOwnedImportJob`) already treats a
 * throw from its start step as a failed step and reads `.message` for the toast.
 */
export async function startDriveImport(
  files: PickedDriveFile[],
): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireSyncUser();
  const staged = await stageDriveImport(userId, files);
  after(() => runDriveImportJob(staged.importId).catch(() => {}));
  return staged;
}

/** Drop a flagged commitment from an import's "Worth a look" list. */
export async function dismissDriveFlag(importId: string, flagId: string): Promise<void> {
  const userId = await requireUserId();
  await removeDriveFlag(userId, importId, flagId);
}
