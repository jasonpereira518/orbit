"use server";

/**
 * Keeping a whole LinkedIn export. Each action is `requireUserId` + one call into
 * `src/lib/linkedin-export-store.ts`. Refusals come back as `{ error }` data — a thrown
 * message is replaced by a digest in production.
 */
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { imports } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { actionFailure } from "@/lib/action-failure";
import { isUserFacingError } from "@/lib/errors";
import { isImportId } from "@/lib/imports/import-ids";
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

/** Close the upload. Nothing runs in the background, so it comes back already completed. */
export async function startLinkedInExport(
  importId: string,
  counts: { tooLarge: number; private: number },
): Promise<{ importId: string; totalRows: number } | Refusal> {
  const userId = await requireUserId();
  if (!isImportId(importId)) return refusal(TRY_AGAIN);
  try {
    const stats = await finishExportUpload(userId, importId, counts);
    const db = await getDb();
    await db
      .update(imports)
      .set({
        status: "completed",
        totalRows: 0,
        stats: { ...stats, runEndedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(and(eq(imports.id, importId), eq(imports.userId, userId)));
    revalidatePath("/imports");
    return { importId, totalRows: 0 };
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
