import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contacts, importJobRows, imports } from "@/db/schema";
import { UserFacingError } from "@/lib/errors";
import { buildDuplicateIndex, DUPLICATE_MERGE_CONFIDENCE, findDuplicateCandidatesIndexed } from "@/lib/duplicates";
import { stageImportRows } from "@/lib/import-job-rows";
import { LINKEDIN_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-import-types";
import { isImportId } from "@/lib/imports/import-ids";
import {
  CONNECTIONS_APPEND_MAX_ROWS,
  CONNECTIONS_MATCH_MAX_ROWS,
  type ConnectionMatch,
  type ConnectionMatchRow,
  type StagedConnectionRow,
} from "@/lib/imports/linkedin-connections-chunks";

/**
 * A LinkedIn connections import that never sends the whole CSV in one request, or receives
 * the whole review list in one response.
 *
 * The one-request path (`previewLinkedInCsv` + `startLinkedInImport`) sent the CSV text up
 * twice and the preview came back with every row in it twice (`people`, and a `preview`
 * alias): ~15 MB at 30,000 connections, the most LinkedIn allows, against a 4.5 MB function
 * response limit; and the upload refused anything over ~39,900 rows. Here the browser parses
 * the file, asks only "which of these are already here?" in chunks (`matchConnections`,
 * answered with the matches alone), and uploads the chosen rows in chunks into a `staging`
 * import that the engine takes over when it is started — the shape chat imports use.
 * An upload whose last chunk never arrives is swept after 24 h with the chat ones
 * (`sweepAbandonedStaging`).
 */

const text = (max: number) => z.string().max(max);

const matchRowSchema: z.ZodType<ConnectionMatchRow> = z.object({
  index: z.number().int().min(0),
  fullName: text(500),
  email: text(500),
  url: text(2_000),
  company: text(500),
  position: text(500),
});

/**
 * The rows that look like someone already in the network, exactly as `previewLinkedInCsv`
 * judges them per row; rows with no candidate are left out of the answer.
 */
export async function matchConnections(userId: string, rows: unknown): Promise<ConnectionMatch[]> {
  const parsed = z.array(matchRowSchema).max(CONNECTIONS_MATCH_MAX_ROWS).safeParse(rows);
  if (!parsed.success) throw new UserFacingError("Part of that file couldn’t be read — try exporting it again");
  const db = await getDb();
  const existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
    columns: { id: true, fullName: true, email: true, linkedinUrl: true, xHandle: true, company: true, title: true },
  });
  const index = buildDuplicateIndex(existing);
  const matches: ConnectionMatch[] = [];
  for (const row of parsed.data) {
    const top = findDuplicateCandidatesIndexed(index, {
      fullName: row.fullName,
      email: row.email,
      linkedinUrl: row.url,
      company: row.company,
      title: row.position,
    })[0];
    if (!top) continue;
    matches.push({
      index: row.index,
      isRepeat: top.confidence >= DUPLICATE_MERGE_CONFIDENCE,
      duplicate: { id: top.contact.id, fullName: top.contact.fullName, reason: top.reason, confidence: top.confidence },
    });
  }
  return matches;
}

const stagedRowSchema: z.ZodType<StagedConnectionRow> = z.object({
  index: z.number().int().min(0),
  firstName: text(500),
  lastName: text(500),
  email: text(500),
  company: text(500),
  position: text(500),
  connectedOn: text(200),
  url: text(2_000),
});

export async function beginConnectionsStaging(userId: string, fileName: string): Promise<{ importId: string }> {
  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType: LINKEDIN_IMPORT_TYPE,
      fileName: (typeof fileName === "string" && fileName.trim().slice(0, 255)) || "linkedin.csv",
      status: "staging",
      totalRows: 0,
      stats: {},
    })
    .returning();
  return { importId: row.id };
}

const OUT_OF_STEP = "That upload got out of step — start the import again";

/**
 * Stage the next chunk. `startIndex` is how many rows are staged already, so chunks land in
 * order and a repeated chunk is refused rather than imported twice. Each row keeps its
 * position in the file as `rowIndex`, as `startLinkedInImport` stages it.
 */
export async function appendConnectionsRows(
  userId: string,
  importId: string,
  startIndex: number,
  rows: unknown,
): Promise<{ appended: number }> {
  const parsed = z.array(stagedRowSchema).min(1).max(CONNECTIONS_APPEND_MAX_ROWS).safeParse(rows);
  if (!parsed.success) throw new UserFacingError("Part of that file couldn’t be read — try exporting it again");
  if (!isImportId(importId) || !Number.isInteger(startIndex) || startIndex < 0) throw new UserFacingError(OUT_OF_STEP);
  const payloads = parsed.data;

  const db = await getDb();
  const claimed = await db
    .update(imports)
    .set({ totalRows: sql`${imports.totalRows} + ${payloads.length}`, updatedAt: new Date() })
    .where(
      and(
        eq(imports.id, importId),
        eq(imports.userId, userId),
        eq(imports.importType, LINKEDIN_IMPORT_TYPE),
        eq(imports.status, "staging"),
        eq(imports.totalRows, startIndex),
      ),
    )
    .returning();
  if (claimed.length === 0) throw new UserFacingError(OUT_OF_STEP);

  try {
    await stageImportRows(payloads.map((payload) => ({ importId, userId, rowIndex: payload.index, payload })));
  } catch (err) {
    // Give the slot back so a retry of this chunk lines up again.
    await db
      .update(imports)
      .set({ totalRows: sql`${imports.totalRows} - ${payloads.length}` })
      .where(and(eq(imports.id, importId), eq(imports.status, "staging")))
      .catch(() => {});
    throw err;
  }
  return { appended: payloads.length };
}

/** Requires `staging`; flips to `processing` with `totalRows` = the staged row count. */
export async function startConnectionsStaged(userId: string, importId: string): Promise<{ totalRows: number }> {
  if (!isImportId(importId)) throw new UserFacingError("That import has already started");
  const db = await getDb();
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(importJobRows)
    .where(and(eq(importJobRows.importId, importId), eq(importJobRows.userId, userId)));
  const totalRows = Number(n);
  if (totalRows === 0) throw new UserFacingError("Pick at least one person to import");
  const updated = await db
    .update(imports)
    .set({ status: "processing", totalRows, updatedAt: new Date() })
    .where(
      and(
        eq(imports.id, importId),
        eq(imports.userId, userId),
        eq(imports.importType, LINKEDIN_IMPORT_TYPE),
        eq(imports.status, "staging"),
      ),
    )
    .returning();
  if (updated.length === 0) throw new UserFacingError("That import has already started");
  return { totalRows };
}
