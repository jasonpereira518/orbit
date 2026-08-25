import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recalibrateCloseness } from "@/lib/closeness-cohort";
import { getDb } from "@/db";
import {
  contacts,
  imports,
  importJobRows,
  type Contact,
  type LinkedInImportRowPayload,
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

function rowFullName(payload: LinkedInImportRowPayload) {
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

/** Row-level reason recorded when the plan's contact limit refused an otherwise-valid row. */
export const PLAN_LIMIT_ROW_REASON = "Contact limit reached on your plan";

/**
 * Mark a chunk's rows done in one statement.
 *
 * Each row carries a different `contact_id`, so this cannot be a plain `WHERE id = ANY(...)`
 * — the values are joined in instead. It used to be one `UPDATE` per row fired through
 * `Promise.all`, which on `neon-http` is one HTTPS request per row, with no transaction to
 * make the chunk atomic. A single statement is both faster and all-or-nothing.
 */
async function markRowsDone(rowIds: string[], contactIdByRowId: Map<string, string>) {
  if (rowIds.length === 0) return;
  const db = await getDb();
  const now = new Date();
  const tuples = rowIds.map(
    (rowId) =>
      sql`(${rowId}::uuid, ${contactIdByRowId.get(rowId) ?? null}::uuid)`
  );
  await db.execute(sql`
    UPDATE import_job_rows AS r
    SET status = 'done', contact_id = v.contact_id, updated_at = ${now}
    FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, contact_id)
    WHERE r.id = v.id
  `);
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
  let blockedByPlanTotal = importRow.stats?.blockedByPlan ?? 0;
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
        // This runner only ever claims rows from a LinkedIn import, so the payload
        // union is narrowed once here rather than at each of the dozen field reads.
        const payload = row.payload as LinkedInImportRowPayload;
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
              // No statedCloseness: nobody has rated these people, and saying
              // "2 out of 5" about two thousand strangers is exactly the
              // assumption this change removes. `contactInsertValues` coalesces
              // `input.relationshipScore ?? 2`, so the legacy column still reads
              // 2 — which is precisely why `resolveStatedStrength` refuses to
              // treat a 2 as an assessment.
              firstInteractionAt: connectedOn ?? undefined,
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

      // `createContactsBulk` admits only what the plan's contact headroom allows, taking
      // from the front, so anything past `created.length` was refused by the cap rather
      // than failed. These rows must reach a terminal status: the loop re-queries pending
      // rows every pass, so leaving them pending would spin until the time budget and then
      // reschedule forever. They are marked `skipped` with a reason, and counted under
      // `blockedByPlan` so the UI can offer an upgrade instead of reporting an error.
      let planBlockedRows: PendingRow[] = [];

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

        if (created.length < toCreate.length) {
          planBlockedRows = toCreate
            .slice(created.length)
            .map((item) => item.row);
          blockedByPlanTotal += planBlockedRows.length;
        }
      }

      for (const item of toUpdate) {
        await updateContact(item.contactId, item.input, {
          skipRevalidate: true,
          skipEmbedding: true,
          // The whole network is recalibrated when the import finishes. Scoring each
          // duplicate as it is merged would issue several extra queries per row to reach a
          // number that is immediately superseded.
          skipCloseness: true,
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

      const blockedRowIds = new Set(planBlockedRows.map((row) => row.id));
      if (blockedRowIds.size > 0) {
        await db
          .update(importJobRows)
          .set({
            status: "skipped",
            errorMessage: PLAN_LIMIT_ROW_REASON,
            updatedAt: new Date(),
          })
          .where(inArray(importJobRows.id, [...blockedRowIds]));
      }

      await markRowsDone(
        [
          ...toCreate
            .map((item) => item.row.id)
            .filter((id) => !blockedRowIds.has(id)),
          ...toUpdate.map((item) => item.row.id),
        ],
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
          stats: {
            ...(current.stats ?? {}),
            skipped: skippedTotal,
            blockedByPlan: blockedByPlanTotal,
          },
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

  // Redraw the distribution once, now that every contact this import will ever add is in.
  // Closeness is cohort-relative, so importing 3,000 people moves where all the existing
  // ones sit; doing it per chunk would recompute the same thing dozens of times over.
  await recalibrateCloseness(importRow.userId).catch(() => null);

  revalidatePath("/");
  revalidatePath("/contacts");
  revalidatePath("/imports");
  revalidatePath("/graph");
  revalidatePath("/knowledge");
  revalidatePath("/chat");
  // Not one revalidation per imported contact. Those paths are dynamic and nobody is
  // holding a cached render of a contact page they have never opened, so a large import
  // was issuing thousands of calls to invalidate nothing.
  if (allTouchedContactIds.size <= PER_CONTACT_REVALIDATE_LIMIT) {
    for (const id of allTouchedContactIds) revalidatePath(`/contacts/${id}`);
  }
}

/**
 * Above this many touched contacts, skip per-contact revalidation entirely — the list and
 * dashboard paths above already cover what a user can actually be looking at.
 */
const PER_CONTACT_REVALIDATE_LIMIT = 50;

/** Exported so the Gmail recruiter scan runner shares one job-failure path. */
export async function failImport(importId: string, err: unknown) {
  const message = err instanceof Error ? err.message : "Import failed";
  const db = await getDb();
  await db
    .update(imports)
    .set({ status: "failed", errorMessage: message.slice(0, 500), updatedAt: new Date() })
    .where(eq(imports.id, importId));
}
