import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { cloudNoteFiles, cloudNoteSources } from "@/db/schema";
import type { CloudProvider } from "@/lib/cloud-files";
import { grantCovers as googleGrantCovers } from "@/lib/google-scopes";
import { grantCovers as microsoftGrantCovers } from "@/lib/microsoft-scopes";

/**
 * The lifecycle of a watched drive. A `cloud_note_sources` row existing IS the opt-in: it is
 * created when a connect comes back holding the read scope, and removed with the connection.
 */

export function grantCoversCloudNotes(provider: CloudProvider, scopes: string | null | undefined): boolean {
  return provider === "google" ? googleGrantCovers("drive_scan", scopes) : microsoftGrantCovers("files", scopes);
}

/** After a connect: start watching when the grant covers it, stop when it no longer does. */
export async function syncCloudNoteSource(userId: string, provider: CloudProvider, scopes: string | null | undefined) {
  if (!grantCoversCloudNotes(provider, scopes)) return dropCloudNoteSource(userId, provider);
  const db = await getDb();
  // A reconnect after a dead grant clears the error and makes the drive due now.
  await db
    .insert(cloudNoteSources)
    .values({ userId, provider })
    .onConflictDoUpdate({
      target: [cloudNoteSources.userId, cloudNoteSources.provider],
      set: { lastError: null, nextScanAt: sql`now()` },
    });
}

/**
 * On disconnect or an account switch. The cursor belongs to the old drive, and docs still
 * waiting to be extracted can no longer be read; extracted ones stay as history.
 */
export async function dropCloudNoteSource(userId: string, provider: CloudProvider) {
  const db = await getDb();
  await db.delete(cloudNoteSources).where(and(eq(cloudNoteSources.userId, userId), eq(cloudNoteSources.provider, provider)));
  await db
    .delete(cloudNoteFiles)
    .where(and(eq(cloudNoteFiles.userId, userId), eq(cloudNoteFiles.provider, provider), eq(cloudNoteFiles.status, "found")));
}
