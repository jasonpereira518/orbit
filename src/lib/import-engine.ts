import { eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recalibrateCloseness } from "@/lib/closeness-cohort";
import { getDb, rowsOf } from "@/db";
import {
  contacts,
  imports,
  importJobRows,
  interactions,
  type ImportJobRowPayload,
  type ImportStats,
} from "@/db/schema";
import {
  bulkMergeContactsForUser,
  contactHeadroomForUser,
  createContactsBulkForUser,
  type ContactInput,
} from "@/lib/contact-writes";
import { getAppBaseUrl } from "@/lib/app-url";
import { createCompanyResolver } from "@/lib/companies";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  addToDuplicateIndex,
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateIndex,
  type DuplicateSubject,
} from "@/lib/duplicates";
import { getAdapter } from "@/lib/import-adapters";
import { startQueryCount, stopQueryCount } from "@/lib/query-counter";

/**
 * Rows pulled from the DB per processing loop iteration. Widened from 40 to cut the fixed
 * per-chunk overhead (status re-read, pending fetch, progress update) a 500-row import
 * pays 13 times over instead of 2. The budget guard in `scripts/smoke-import-perf.ts`,
 * not intuition, is what actually bounds how far this can go — it asserts a statements-
 * per-chunk ceiling that would catch a per-row regression long before chunk width would.
 */
export const CHUNK_SIZE = 250;
/** Stay well under the 300s function ceiling, leaving room for the self-continuation call. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;

/** The incoming shape `findDuplicateCandidatesIndexed` already accepts. */
export type DuplicateProbe = {
  fullName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  company?: string | null;
  title?: string | null;
};

export type InteractionInsert = typeof interactions.$inferInsert;

/**
 * Everything an import type has to say about its own rows.
 *
 * Deliberately all pure functions: the engine owns every database statement, which is the
 * only way the per-chunk round-trip budget can be a property of the system rather than a
 * habit each importer has to remember.
 */
export type ImportAdapter<P> = {
  /** Fields the duplicate index probes. `null` marks the row skipped. */
  identity(payload: P): DuplicateProbe | null;
  /** The contact to insert when nothing matches confidently. */
  toCreate(payload: P): ContactInput;
  /** The column patch to apply when a confident duplicate matches. */
  toMerge(payload: P, matched: DuplicateSubject): Partial<ContactInput>;
  /**
   * Set false for imports that only annotate people already in the network (calendar).
   * The engine then skips the create branch and the plan cap entirely — a calendar file
   * cannot push a free user over their contact limit, because it adds no contacts.
   */
  createsContacts?: boolean;
  /** Interaction rows to bulk-insert for this payload, once its contact id is known. */
  interactions?(payload: P, contactId: string, userId: string): InteractionInsert[];
};

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

/**
 * Fire-and-forget the embedding backfill for this user.
 *
 * Through the route rather than inline: the import is finished from the user's point of
 * view, and embedding a few thousand contacts can outlive this invocation. The daily cron
 * is a backstop only — it runs at most once every 24 hours (the Hobby-plan minimum),
 * which is far too slow to be the primary path.
 */
async function kickEmbeddingBackfill(userId: string) {
  const secret = process.env.CRON_SECRET;
  try {
    await fetch(`${getAppBaseUrl()}/api/embeddings/backfill`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ userId }),
    });
  } catch {
    // Best-effort — the cron backstop picks up anything still flagged.
  }
}

/**
 * Shape of a row returned by the claiming `UPDATE ... RETURNING` below — the columns that
 * statement actually selects, not the full `import_job_rows` schema. `errorMessage` /
 * `createdAt` are deliberately absent: nothing downstream reads them, so there's no reason
 * to fabricate values for them just to match the table's inferred type.
 */
type PendingRow = {
  id: string;
  importId: string;
  userId: string;
  rowIndex: number;
  payload: ImportJobRowPayload;
  status: string;
  contactId: string | null;
};

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
 * Folds this invocation's cost into whatever `stats` the row already carried, rather than
 * overwriting it. A self-continuing job runs this once per invocation — at the time-budget
 * early return and again (or instead) at completion — and the interesting number is the
 * total across every invocation, not just the one that happened to finish the job.
 *
 * Stops the query counter as a side effect, so call this at most once per invocation: once
 * stopped, a second call in the same invocation would sum in an empty (zeroed) count rather
 * than a real one. The two call sites in `runImportJob` are mutually exclusive — the
 * time-budget return exits the function before the loop can break into the completion
 * path — so this constraint holds without extra bookkeeping.
 */
function accumulatedStats(
  latestStats: ImportStats,
  jobStart: number,
  skippedTotal: number,
  blockedByPlanTotal: number
): ImportStats {
  return {
    ...latestStats,
    skipped: skippedTotal,
    blockedByPlan: blockedByPlanTotal,
    durationMs: (latestStats.durationMs ?? 0) + (Date.now() - jobStart),
    statements: (latestStats.statements ?? 0) + stopQueryCount(),
  };
}

/**
 * Processes pending `import_job_rows` for a server-owned import job in time-boxed chunks.
 * Safe to call repeatedly (self-continuation, cron resume, manual retry) — it always
 * re-reads job/row status from the DB rather than assuming it's starting fresh.
 *
 * Everything import-type-specific lives in the adapter resolved below; this function owns
 * every database statement, which is what keeps the round-trip budget a property of the
 * system rather than something each importer has to remember.
 */
export async function runImportJob(importId: string): Promise<void> {
  const db = await getDb();
  const jobStart = Date.now();
  startQueryCount();

  const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!importRow) return;
  if (["completed", "failed", "cancelled"].includes(importRow.status)) return;

  // Resolved once, from the type recorded on the job row. Import kinds with no server-side
  // runner (the client-driven ones) resolve to `null` and are left alone rather than being
  // pushed through a loop that has no idea what their payloads mean.
  const adapter = getAdapter(importRow.importType);
  if (!adapter) return;
  const createsContacts = adapter.createsContacts !== false;

  const userId = importRow.userId;

  let existingContacts: DuplicateSubject[];
  let duplicateIndex: DuplicateIndex;
  let companyResolve: Awaited<ReturnType<typeof createCompanyResolver>>;
  try {
    existingContacts = await db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        fullName: true,
        email: true,
        linkedinUrl: true,
        company: true,
        title: true,
      },
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
  // Refreshed every loop pass from the row this job's own writes are updating, so the
  // final completion update below folds in whatever another process wrote to `stats`
  // (e.g. Gmail-scan-style concurrent fields) instead of the snapshot from job start,
  // which a self-continuing job would otherwise stomp back to a stale value.
  let latestStats = importRow.stats ?? {};
  const allTouchedContactIds = new Set<string>();

  try {
    // Counted once per invocation, not once per chunk: the number only moves because this
    // loop moves it, so re-deriving it with a full table count every chunk is a round trip
    // spent confirming arithmetic we already did. An adapter that creates no contacts skips
    // the count entirely — it is a statement spent bounding something that cannot happen.
    let headroom = createsContacts ? await contactHeadroomForUser(userId) : null;

    while (true) {
      if (Date.now() - jobStart > TIME_BUDGET_MS) {
        // Persist this invocation's cost before handing off, or it is lost: this
        // invocation never reaches the completion write below, and the next invocation's
        // own `startQueryCount()` resets the in-memory counter to zero. Without this write,
        // a job spanning N invocations would report only the cost of its last one.
        await db
          .update(imports)
          .set({
            stats: accumulatedStats(latestStats, jobStart, skippedTotal, blockedByPlanTotal),
            updatedAt: new Date(),
          })
          .where(eq(imports.id, importId));
        await scheduleContinuation(importId);
        return;
      }

      const current = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
      if (!current || current.status !== "processing") return;
      latestStats = current.stats ?? {};

      /**
       * Claim the next chunk in the same statement that reads it.
       *
       * `neon-http` has no transactions, so a crash between "insert contacts" and "mark
       * rows done" would otherwise leave rows `pending` and re-create their contacts on
       * resume. Claiming first means an interrupted chunk is left `processing`, and a
       * resumed job re-runs those rows through the duplicate index — which now matches the
       * contact that was created and merges instead of duplicating. Self-healing for any
       * row carrying a LinkedIn URL or an email; a name-only row can still duplicate,
       * which is strictly better than the alternative and worth knowing about.
       *
       * It also costs nothing: one UPDATE replaces one SELECT.
       */
      const claimed = await db.execute(sql`
        UPDATE import_job_rows SET status = 'processing', updated_at = ${new Date()}
        WHERE id IN (
          SELECT id FROM import_job_rows
          WHERE import_id = ${importId} AND status IN ('pending', 'processing')
          ORDER BY row_index
          LIMIT ${CHUNK_SIZE}
        )
        RETURNING id, row_index, payload, status, contact_id
      `);

      // Raw SQL returns actual Postgres column names (snake_case), not Drizzle's camelCase
      // mapping — the loop below reads `rowIndex`/`contactId` on `PendingRow`, so those are
      // mapped explicitly rather than assumed. `rowsOf` normalizes the driver-dependent
      // shape: an array on `neon-http`, `{ rows }` on PGlite.
      const pendingRows: PendingRow[] = rowsOf<{
        id: string;
        row_index: number;
        payload: ImportJobRowPayload;
        status: string;
        contact_id: string | null;
      }>(claimed).map((row) => ({
        id: row.id,
        importId,
        userId,
        rowIndex: row.row_index,
        payload: row.payload,
        status: row.status,
        contactId: row.contact_id,
      }));

      if (pendingRows.length === 0) break;

      const toCreate: { row: PendingRow; input: ContactInput }[] = [];
      const toUpdate: { row: PendingRow; contactId: string; input: Partial<ContactInput> }[] = [];
      const toSkip: PendingRow[] = [];

      for (const row of pendingRows) {
        // The adapter was chosen from this job's own `importType` and the rows belong to
        // that job, so the payload union is narrowed once here rather than at each of the
        // dozen field reads inside the adapter.
        const payload = row.payload as ImportJobRowPayload;
        const probe = adapter.identity(payload);
        if (!probe) {
          toSkip.push(row);
          continue;
        }

        const dups = findDuplicateCandidatesIndexed(duplicateIndex, probe);

        if (dups[0] && dups[0].confidence >= DUPLICATE_MERGE_CONFIDENCE) {
          toUpdate.push({
            row,
            contactId: dups[0].contact.id,
            input: adapter.toMerge(payload, dups[0].contact),
          });
        } else if (createsContacts) {
          toCreate.push({ row, input: adapter.toCreate(payload) });
        } else {
          // An annotate-only import (calendar) has nobody to attach this row to. It still
          // has to reach a terminal status: the loop re-queries pending rows every pass, so
          // leaving it pending would spin until the time budget and then reschedule forever.
          toSkip.push(row);
        }
      }

      // Cancellation latency is a direct cost of the wider chunk. Classification is pure
      // and cheap, so checking here — after the rows are sorted into create/merge/skip but
      // before anything is written — costs one statement and halves the wait.
      const stillRunning = await db.query.imports.findFirst({
        where: eq(imports.id, importId),
        columns: { status: true },
      });
      if (stillRunning?.status !== "processing") return;

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
        const created = await createContactsBulkForUser(
          userId,
          toCreate.map((item) => item.input),
          companyResolve,
          { skipRevalidate: true, skipEmbedding: true, headroom }
        );
        created.forEach((contact, i) => {
          addToDuplicateIndex(duplicateIndex, contact);
          contactIdByRowId.set(toCreate[i].row.id, contact.id);
          touchedContactIds.push(contact.id);
        });
        contactsCreated += created.length;
        if (headroom !== null) headroom = Math.max(0, headroom - created.length);

        if (created.length < toCreate.length) {
          planBlockedRows = toCreate
            .slice(created.length)
            .map((item) => item.row);
          blockedByPlanTotal += planBlockedRows.length;
        }
      }

      if (toUpdate.length > 0) {
        await bulkMergeContactsForUser(
          userId,
          toUpdate.map((item) => ({ contactId: item.contactId, input: item.input })),
          companyResolve
        );
        for (const item of toUpdate) {
          contactIdByRowId.set(item.row.id, item.contactId);
          touchedContactIds.push(item.contactId);
        }
        contactsUpdated += toUpdate.length;
        duplicatesFound += toUpdate.length;
      }

      // One insert for the whole chunk, not one per row: an importer that logs a meeting or
      // a message per row is exactly the shape that made this pipeline per-row in the first
      // place. `onConflictDoNothing` leans on the soft-unique (user_id, external_id) index
      // the interactions table already carries for import dedupe, so a retried chunk
      // re-inserting rows it already wrote is a no-op rather than a failed import.
      if (adapter.interactions) {
        const interactionRows: InteractionInsert[] = [];
        for (const row of pendingRows) {
          const contactId = contactIdByRowId.get(row.id);
          if (!contactId) continue;
          interactionRows.push(
            ...adapter.interactions(row.payload as ImportJobRowPayload, contactId, userId)
          );
        }
        if (interactionRows.length > 0) {
          await db.insert(interactions).values(interactionRows).onConflictDoNothing();
        }
      }

      for (const id of touchedContactIds) allTouchedContactIds.add(id);

      const blockedRowIds = new Set(planBlockedRows.map((row) => row.id));
      const doneRowIds = [
        ...toCreate
          .map((item) => item.row.id)
          .filter((id) => !blockedRowIds.has(id)),
        ...toUpdate.map((item) => item.row.id),
      ];

      // These three writes touch disjoint row sets — blockedRowIds is a subset of
      // toCreate's rows that createContactsBulkForUser refused, doneRowIds is every
      // toCreate/toUpdate row except those, and toSkip is rows filtered out before either
      // bulk write ran — so there is nothing to gain from running them one after another.
      await Promise.all([
        blockedRowIds.size > 0
          ? db
              .update(importJobRows)
              .set({
                status: "skipped",
                errorMessage: PLAN_LIMIT_ROW_REASON,
                updatedAt: new Date(),
              })
              .where(inArray(importJobRows.id, [...blockedRowIds]))
          : Promise.resolve(),
        markRowsDone(doneRowIds, contactIdByRowId),
        toSkip.length > 0
          ? db
              .update(importJobRows)
              .set({ status: "skipped", updatedAt: new Date() })
              .where(inArray(importJobRows.id, toSkip.map((row) => row.id)))
          : Promise.resolve(),
      ]);

      if (toSkip.length > 0) skippedTotal += toSkip.length;

      rowsProcessed += toCreate.length + toUpdate.length;

      await db
        .update(imports)
        .set({
          rowsProcessed,
          contactsCreated,
          contactsUpdated,
          duplicatesFound,
          stats: {
            ...latestStats,
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
    .set({
      status: "completed",
      stats: accumulatedStats(latestStats, jobStart, skippedTotal, blockedByPlanTotal),
      updatedAt: new Date(),
    })
    .where(eq(imports.id, importId));

  // Redraw the distribution once, now that every contact this import will ever add is in.
  // Closeness is cohort-relative, so importing 3,000 people moves where all the existing
  // ones sit; doing it per chunk would recompute the same thing dozens of times over. This
  // is also why neither the create nor the merge path scores rows as they land: scoring a
  // duplicate as it is merged would issue extra queries per row to reach a number that is
  // immediately superseded by this recalibration.
  await recalibrateCloseness(importRow.userId).catch(() => null);
  await kickEmbeddingBackfill(importRow.userId);

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
