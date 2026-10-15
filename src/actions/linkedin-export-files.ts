"use server";

/**
 * Keeping a whole LinkedIn export. Each action is `requireUserId` + one call into
 * `src/lib/linkedin-export-store.ts`. Refusals come back as `{ error }` data — a thrown
 * message is replaced by a digest in production.
 */
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { actionFailure } from "@/lib/action-failure";
import { isUserFacingError } from "@/lib/errors";
import { isImportId } from "@/lib/imports/import-ids";
import { runImportJobById } from "@/lib/import-job-dispatch";
import { applyExportExtras } from "@/lib/linkedin-export-apply";
import {
  appendExportFiles,
  beginExport,
  deleteExportFiles,
  finishExportUpload,
  listExportFiles,
  type ExportFileListing,
  type ExportFileUpload,
} from "@/lib/linkedin-export-store";

type Refusal = { error: string };

function refusal(message: string): Refusal {
  return { error: message };
}

async function failure(err: unknown, fallback: string, where: string): Promise<Refusal> {
  return refusal(isUserFacingError(err) ? err.message : await actionFailure(err, fallback, where));
}

const TRY_AGAIN = "Couldn’t keep your LinkedIn export — drop it again";

export async function beginLinkedInExport(fileName: string): Promise<{ importId: string } | Refusal> {
  const userId = await requireUserId();
  try {
    return await beginExport(userId, typeof fileName === "string" ? fileName : "");
  } catch (err) {
    return failure(err, TRY_AGAIN, "linkedin-export-files.begin");
  }
}

export async function appendLinkedInExportFiles(
  importId: string,
  files: ExportFileUpload[],
): Promise<{ saved: number } | Refusal> {
  const userId = await requireUserId();
  if (!isImportId(importId)) return refusal(TRY_AGAIN);
  try {
    return await appendExportFiles(userId, importId, files);
  } catch (err) {
    return failure(err, TRY_AGAIN, "linkedin-export-files.append");
  }
}

/**
 * Close the upload and read the useful files: target companies and background land now; the
 * per-person notes are staged and attached by the engine in the background, like any import.
 */
export async function startLinkedInExport(
  importId: string,
  counts: { tooLarge: number; private: number },
): Promise<{ importId: string; totalRows: number } | Refusal> {
  const userId = await requireUserId();
  if (!isImportId(importId)) return refusal(TRY_AGAIN);
  try {
    const stats = await finishExportUpload(userId, importId, counts);
    const extras = await applyExportExtras(userId, importId);
    const db = await getDb();
    await db
      .update(imports)
      .set({
        status: extras.rows ? "processing" : "completed",
        totalRows: extras.rows,
        stats: {
          ...stats,
          targetsAdded: extras.targetsAdded,
          backgroundAdded: extras.backgroundAdded,
          ...(extras.rows ? {} : { runEndedAt: new Date().toISOString() }),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(imports.id, importId), eq(imports.userId, userId)));
    if (extras.rows) after(() => runImportJobById(importId).catch(() => {}));
    revalidatePath("/imports");
    revalidatePath("/settings");
    return { importId, totalRows: extras.rows };
  } catch (err) {
    return failure(err, TRY_AGAIN, "linkedin-export-files.start");
  }
}

export async function listLinkedInExportFiles(importId: string): Promise<ExportFileListing[]> {
  const userId = await requireUserId();
  if (!isImportId(importId)) return [];
  return listExportFiles(userId, importId);
}

/** Forget the export's files; its history row stays. */
export async function deleteLinkedInExportFiles(importId: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  if (!isImportId(importId)) return refusal("Couldn’t delete those files — try again");
  try {
    await deleteExportFiles(userId, importId);
    revalidatePath("/imports");
    return { ok: true };
  } catch (err) {
    return failure(err, "Couldn’t delete those files — try again", "linkedin-export-files.delete");
  }
}
