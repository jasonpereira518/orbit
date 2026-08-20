import { and, asc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  contacts,
  imports,
  importJobRows,
  type Contact,
  type ImportJobRowPayload,
} from "@/db/schema";
import { createContactsBulk, updateContact, type ContactInput } from "@/actions/contacts";
import { getAppBaseUrl } from "@/lib/app-url";
import { createCompanyResolver } from "@/lib/companies";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  addToDuplicateIndex,
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateIndex,
} from "@/lib/duplicates";
import { parseConnectedOn } from "@/lib/linkedin-connections";
import { rebuildContactEmbeddingsBatch } from "@/lib/search";

/** Rows pulled from the DB per processing loop iteration. */
const CHUNK_SIZE = 40;
/** Stay well under the 300s function ceiling, leaving room for the self-continuation call. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;

function rowFullName(payload: ImportJobRowPayload) {
  return `${payload.firstName} ${payload.lastName}`.trim();
}

/** Kick a self-continuation request so remaining rows keep processing in a fresh invocation. */
async function scheduleContinuation(importId: string) {
  const secret = process.env.CRON_SECRET;
  try {
    await fetch(`${getAppBaseUrl()}/api/imports/${importId}/continue`, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
    });
  } catch {
    // Best-effort — the process-stalled cron will pick this job back up.
  }
}

type PendingRow = typeof importJobRows.$inferSelect;

async function markRowsDone(rowIds: string[], contactIdByRowId: Map<string, string>) {
  if (rowIds.length === 0) return;
  const db = await getDb();
  await Promise.all(
    rowIds.map((rowId) =>
      db
        .update(importJobRows)
        .set({
          status: "done",
          contactId: contactIdByRowId.get(rowId) ?? null,
          updatedAt: new Date(),
        })
        .where(eq(importJobRows.id, rowId))
    )
  );
}

/**
 * Processes pending `import_job_rows` for a LinkedIn connections import job in
 * time-boxed chunks. Safe to call repeatedly (self-continuation, cron resume,
 * manual retry) — it always re-reads job/row status from the DB rather than
 * assuming it's starting fresh.
 */
export async function runLinkedInImportJob(importId: string): Promise<void> {
  const db = await getDb();
  const jobStart = Date.now();

  const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!importRow) return;
  if (["completed", "failed", "cancelled"].includes(importRow.status)) return;

  const userId = importRow.userId;

  let existingContacts: Contact[];
  let duplicateIndex: DuplicateIndex;
  let companyResolve: Awaited<ReturnType<typeof createCompanyResolver>>;
  try {
    existingContacts = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
    });
    duplicateIndex = buildDuplicateIndex(existingContacts);
    companyResolve = await createCompanyResolver(userId);
  } catch (err) {
    await failImport(importId, err);
    return;
  }

  let contactsCreated = importRow.contactsCreated ?? 0;
  let contactsUpdated = importRow.contactsUpdated ?? 0;
  let duplicatesFound = importRow.duplicatesFound ?? 0;
  let rowsProcessed = importRow.rowsProcessed ?? 0;
  let skippedTotal = importRow.stats?.skipped ?? 0;
  const allTouchedContactIds = new Set<string>();

  try {
    while (true) {
      if (Date.now() - jobStart > TIME_BUDGET_MS) {
        await scheduleContinuation(importId);
        return;
      }

      const current = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
      if (!current || current.status !== "processing") return;

      const pendingRows: PendingRow[] = await db.query.importJobRows.findMany({
        where: and(eq(importJobRows.importId, importId), eq(importJobRows.status, "pending")),
        orderBy: [asc(importJobRows.rowIndex)],
        limit: CHUNK_SIZE,
      });

      if (pendingRows.length === 0) break;

      const toCreate: { row: PendingRow; input: ContactInput }[] = [];
      const toUpdate: { row: PendingRow; contactId: string; input: Partial<ContactInput> }[] = [];
      const toSkip: PendingRow[] = [];

      for (const row of pendingRows) {
        const payload = row.payload;
        const fullName = rowFullName(payload);
        if (!fullName) {
          toSkip.push(row);
          continue;
        }

        const connectedOn = parseConnectedOn(payload.connectedOn || "");
        const dups = findDuplicateCandidatesIndexed(duplicateIndex, {
          fullName,
          email: payload.email,
          linkedinUrl: payload.url,
          company: payload.company,
          title: payload.position,
        });

        if (dups[0] && dups[0].confidence >= DUPLICATE_MERGE_CONFIDENCE) {
          toUpdate.push({
            row,
            contactId: dups[0].contact.id,
            input: {
              company: payload.company || undefined,
              title: payload.position || undefined,
              email: payload.email || undefined,
              linkedinUrl: payload.url || undefined,
              firstName: payload.firstName || undefined,
              lastName: payload.lastName || undefined,
              source: "linkedin",
              dateMet: connectedOn || undefined,
              howMet: "LinkedIn connection",
              metContext: "online",
            },
          });
        } else {
          toCreate.push({
            row,
            input: {
              fullName,
              firstName: payload.firstName,
              lastName: payload.lastName,
              company: payload.company || undefined,
              title: payload.position || undefined,
              email: payload.email || undefined,
              linkedinUrl: payload.url || undefined,
              source: "linkedin",
              relationshipScore: 2,
              dateMet: connectedOn,
              howMet: "LinkedIn connection",
              metContext: "online",
              tagNames: ["linkedin"],
            },
          });
        }
      }

      const touchedContactIds: string[] = [];
      const contactIdByRowId = new Map<string, string>();

      if (toCreate.length > 0) {
        const created = await createContactsBulk(
          toCreate.map((item) => item.input),
          companyResolve,
          { skipRevalidate: true, skipEmbedding: true }
        );
        created.forEach((contact, i) => {
          addToDuplicateIndex(duplicateIndex, contact);
          contactIdByRowId.set(toCreate[i].row.id, contact.id);
          touchedContactIds.push(contact.id);
        });
        contactsCreated += created.length;
      }

      for (const item of toUpdate) {
        await updateContact(item.contactId, item.input, {
          skipRevalidate: true,
          skipEmbedding: true,
        });
        contactIdByRowId.set(item.row.id, item.contactId);
        touchedContactIds.push(item.contactId);
        contactsUpdated += 1;
        duplicatesFound += 1;
      }

      if (touchedContactIds.length > 0) {
        await rebuildContactEmbeddingsBatch(userId, touchedContactIds);
        for (const id of touchedContactIds) allTouchedContactIds.add(id);
      }

      await markRowsDone(
        [...toCreate.map((item) => item.row.id), ...toUpdate.map((item) => item.row.id)],
        contactIdByRowId
      );

      if (toSkip.length > 0) {
        await db
          .update(importJobRows)
          .set({ status: "skipped", updatedAt: new Date() })
          .where(inArray(importJobRows.id, toSkip.map((row) => row.id)));
        skippedTotal += toSkip.length;
      }

      rowsProcessed += toCreate.length + toUpdate.length;

      await db
        .update(imports)
        .set({
          rowsProcessed,
          contactsCreated,
          contactsUpdated,
          duplicatesFound,
          stats: { ...(current.stats ?? {}), skipped: skippedTotal },
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(imports.id, importId));
    }
  } catch (err) {
    await failImport(importId, err);
    return;
  }

  await db
    .update(imports)
    .set({ status: "completed", updatedAt: new Date() })
    .where(eq(imports.id, importId));

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/imports");
  revalidatePath("/graph");
  revalidatePath("/knowledge");
  revalidatePath("/chat");
  for (const id of allTouchedContactIds) revalidatePath(`/contacts/${id}`);
}

async function failImport(importId: string, err: unknown) {
  const message = err instanceof Error ? err.message : "Import failed";
  const db = await getDb();
  await db
    .update(imports)
    .set({ status: "failed", errorMessage: message.slice(0, 500), updatedAt: new Date() })
    .where(eq(imports.id, importId));
}
