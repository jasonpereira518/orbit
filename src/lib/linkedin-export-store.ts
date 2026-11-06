import { and, asc, eq, ne, sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import { getDb } from "@/db";
import { importFiles, imports, type ImportStats } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { MAX_EXPORT_FILE_GZ_CHARS } from "@/lib/imports/export-upload";
import { linkedInExportRole } from "@/lib/imports/linkedin-export-files";
import { LINKEDIN_EXPORT_IMPORT_TYPE } from "@/lib/linkedin-export-type";

/*
 * Keeping a LinkedIn export: one `imports` row of type LINKEDIN_EXPORT_IMPORT_TYPE per upload,
 * its CSVs in `import_files`. Begin → append (batched, each under the request cap) → finish,
 * the same three-step shape the chat import uses, and for the same reason: a whole export does
 * not fit one Server Action body.
 */

/** An export is ~35 CSVs; this only stops a runaway client. */
const MAX_EXPORT_FILES = 200;
/** Decompression ceiling when a stored file is read back, so a crafted upload cannot balloon. */
const MAX_EXPORT_FILE_BYTES = 64 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type ExportFileUpload = { path: string; byteSize: number; gz: string };

async function ownStagingExport(userId: string, importId: string) {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(
      eq(imports.id, importId),
      eq(imports.userId, userId),
      eq(imports.importType, LINKEDIN_EXPORT_IMPORT_TYPE),
    ),
    columns: { id: true, status: true },
  });
  if (!row || row.status !== "staging") {
    throw new UserFacingError("That upload has already finished — drop the export again");
  }
  return row;
}

export async function beginExport(userId: string, fileName: string): Promise<{ importId: string }> {
  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType: LINKEDIN_EXPORT_IMPORT_TYPE,
      fileName: fileName.slice(0, 200) || "LinkedIn export",
      status: "staging",
      totalRows: 0,
      stats: {},
    })
    .returning();
  return { importId: row.id };
}

/**
 * Keep a batch of files. The role is decided HERE from the path, not taken from the browser:
 * a private member that reaches the server anyway (an old client, a hand-made request) is
 * dropped, never stored.
 */
export async function appendExportFiles(
  userId: string,
  importId: string,
  files: ExportFileUpload[],
): Promise<{ saved: number }> {
  await ownStagingExport(userId, importId);
  const rows = (Array.isArray(files) ? files : []).flatMap((f) => {
    if (typeof f?.path !== "string" || typeof f.gz !== "string" || f.path.length > 300) return [];
    const role = linkedInExportRole(f.path);
    if (role !== "parsed" && role !== "stored") return [];
    if (f.gz.length > MAX_EXPORT_FILE_GZ_CHARS || !BASE64.test(f.gz)) return [];
    const byteSize = Number.isSafeInteger(f.byteSize) && f.byteSize >= 0 ? f.byteSize : 0;
    return [{ userId, importId, path: f.path, role, byteSize, gz: f.gz }];
  });
  if (!rows.length) return { saved: 0 };

  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(importFiles)
    .where(eq(importFiles.importId, importId));
  if (Number(n) + rows.length > MAX_EXPORT_FILES) {
    throw new UserFacingError("That’s more files than a LinkedIn export has");
  }
  // No RETURNING: it would ship every file's gz straight back. A re-sent path is a no-op.
  await db.insert(importFiles).values(rows).onConflictDoNothing();
  return { saved: rows.length };
}

/**
 * Close the upload: record what was kept and drop the files of every earlier export, so only
 * the latest is held. The earlier `imports` rows stay — they are history.
 *
 * Returns the stats to merge; the caller decides the final status (the extras job may run).
 */
export async function finishExportUpload(
  userId: string,
  importId: string,
  counts: { tooLarge: number; private: number },
): Promise<ImportStats> {
  await ownStagingExport(userId, importId);
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(importFiles)
    .where(eq(importFiles.importId, importId));
  await db
    .delete(importFiles)
    .where(and(eq(importFiles.userId, userId), ne(importFiles.importId, importId)));
  const clamp = (v: number) => (Number.isSafeInteger(v) && v >= 0 ? Math.min(v, MAX_EXPORT_FILES) : 0);
  return {
    filesSaved: Number(n),
    filesTooLarge: clamp(counts.tooLarge),
    filesPrivate: clamp(counts.private),
  };
}

export function gunzipExportFile(gz: string): string {
  return gunzipSync(Buffer.from(gz, "base64"), { maxOutputLength: MAX_EXPORT_FILE_BYTES }).toString("utf8");
}

/** The text of every kept file of one export, by lowercased path. Unreadable files are left out. */
export async function readExportTexts(userId: string, importId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db
    .select({ path: importFiles.path, gz: importFiles.gz })
    .from(importFiles)
    .where(and(eq(importFiles.importId, importId), eq(importFiles.userId, userId)));
  const out = new Map<string, string>();
  for (const r of rows) {
    try {
      out.set(r.path.toLowerCase(), gunzipExportFile(r.gz));
    } catch {
      // A corrupt upload reads as absent, never as an error for the whole export.
    }
  }
  return out;
}

export type ExportFileListing = { id: string; path: string; byteSize: number; role: "parsed" | "stored" };

/** The kept files of one export, for its history row. Never the contents. */
export async function listExportFiles(userId: string, importId: string): Promise<ExportFileListing[]> {
  const db = await getDb();
  return db
    .select({ id: importFiles.id, path: importFiles.path, byteSize: importFiles.byteSize, role: importFiles.role })
    .from(importFiles)
    .where(and(eq(importFiles.importId, importId), eq(importFiles.userId, userId)))
    .orderBy(asc(importFiles.path));
}

/** Forget an export's files. The history row stays. */
export async function deleteExportFiles(userId: string, importId: string): Promise<void> {
  const db = await getDb();
  await db
    .delete(importFiles)
    .where(and(eq(importFiles.importId, importId), eq(importFiles.userId, userId)));
}
