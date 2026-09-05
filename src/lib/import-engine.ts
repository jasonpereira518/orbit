import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recalibrateCloseness } from "@/lib/closeness-cohort";
import { getDb, rowsOf } from "@/db";
import {
  contacts,
  imports,
  importJobRows,
  interactions,
  reminders,
  type ImportJobRowPayload,
  type ImportStats,
} from "@/db/schema";
import {
  bulkMergeContactsForUser,
  contactHeadroomForUser,
  createContactsBulkForUser,
  type ContactInput,
} from "@/lib/contact-writes";
import { internalFetch } from "@/lib/internal-auth";
import { createCompanyResolver } from "@/lib/companies";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { refreshOutreachSuggestions } from "@/lib/reminders";
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

/**
 * Ceiling on how many rows a single chunk's narrowing (`writeWithNarrowing`, below) may mark
 * `failed`, shared across that chunk's create batch and its merge batch — a systemic fault
 * can surface from either bulk write, and it's the same underlying failure either way.
 *
 * Genuinely bad data is rare and scattered: a handful of isolated bad rows in a quarter's
 * worth of contacts is the expected shape narrowing exists to isolate. A systemic fault
 * (a dropped connection, a timeout) instead fails *every* row in the chunk, and narrowing's
 * halving-to-single-rows would otherwise mark all of them `failed` — one at a time, each
 * carrying whatever transient error was thrown — turning a retryable blip into permanent
 * data loss. This budget is what tells the two shapes apart. It deliberately does not try to
 * classify the error itself (a dropped Neon connection and a PGlite timeout do not throw the
 * same error type, and a future driver would be a third) — counting failures is reliable
 * where sniffing error types is not.
 *
 * 10% of a chunk. Once spent, narrowing throws instead of marking the next row — see
 * `runImportJob`'s `onBadRow`. That escapes `writeWithNarrowing` entirely and propagates out
 * of `runImportJob`'s own try/catch, which fails the *import* (the old, pre-narrowing
 * behavior) rather than the row, and leaves the rest of this chunk's rows exactly where the
 * claim left them: `processing`, and reclaimable by the widened `IN ('pending', 'processing')`
 * claim on the next attempt.
 */
export const MAX_ROW_FAILURES_PER_CHUNK = Math.floor(CHUNK_SIZE * 0.1);

/** The incoming shape `findDuplicateCandidatesIndexed` already accepts. */
export type DuplicateProbe = {
  fullName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  company?: string | null;
  title?: string | null;
};

export type InteractionInsert = typeof interactions.$inferInsert;
export type ReminderInsert = typeof reminders.$inferInsert;

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
  /**
   * Confidence floor at/above which a match routes to `toMerge` instead of (for a
   * `createsContacts: false` adapter) `skipped`. Defaults to `DUPLICATE_MERGE_CONFIDENCE`
   * (0.85) — the bar for treating two rows as "the same person," which is what every
   * contact-creating adapter needs before it merges instead of creating a duplicate.
   *
   * A `createsContacts: false` adapter is not making that call. Calendar match confidence
   * (0.6, the weakest tier `findDuplicateCandidatesIndexed` produces — a bare full-name hit)
   * only means "this attendee correlates with this known contact," not "these two rows
   * describe the same person to merge." Logging a meeting against the wrong same-named
   * contact is a much smaller mistake than silently merging two different people's contact
   * records, which is why calendar can afford a floor the create-side adapters cannot.
   * `toMerge` still runs for a calendar match — the widen-on-merge machinery
   * (`bulkMergeContactsForUser`'s `LEAST`/`GREATEST` on the interaction timestamps) is
   * exactly what a matched-but-not-merged row needs, it just needs it at a lower bar.
   */
  matchConfidence?: number;
  /** Interaction rows to bulk-insert for this payload, once its contact id is known. */
  interactions?(payload: P, contactId: string, userId: string): InteractionInsert[];
  /**
   * Reminder rows to bulk-insert for this payload, once its contact id is known — a second
   * bulk insert alongside `interactions`, not folded into it (they're different tables).
   * `reminders` carries no soft-unique column to `onConflictDoNothing()` against the way
   * `interactions.externalId` does, so the engine dedupes these itself with one bulk
   * `SELECT` per chunk, scoped to the contacts this chunk actually touched, matching on the
   * exact (contactId, description) pair — deterministic per adapter row, so a re-uploaded
   * file reproduces the same candidates and they're filtered out rather than inserted again.
   */
  reminders?(payload: P, contactId: string, userId: string): ReminderInsert[];
  /**
   * Optional once-per-job finalization step, called after the chunk loop completes with
   * every contact id this job touched (created or merged) across every chunk. Non-fatal —
   * the engine wraps the call in `.catch(() => null)`, the same ignorable-failure treatment
   * `refreshOutreachSuggestions` and `recalibrateCloseness` already get, so a bug here can
   * never fail an otherwise-successful import.
   *
   * This is the seam for work that has to run once over the whole touched set rather than
   * per row or per chunk — e.g. the LinkedIn messages adapter's AI enrichment pass, which
   * re-reads each contact's `interactions` rows itself rather than needing anything from
   * the payload. Deliberately NOT called per chunk: an adapter that used it for something
   * chunk-sized would reintroduce the per-chunk provider-call cost Phase 2 removed from the
   * embedding path.
   */
  finalize?(userId: string, contactIds: string[]): Promise<void>;
};

/** Kick a self-continuation request so remaining rows keep processing in a fresh invocation. */
async function scheduleContinuation(importId: string) {
  try {
    await internalFetch(`/api/imports/${importId}/continue`, { method: "POST" });
  } catch {
    // Best-effort — the process-stalled cron will pick this job back up.
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
 * Run a chunk's writes, splitting on failure until the bad rows are isolated.
 *
 * With 250-row statements, all-or-nothing failure means one malformed row costs an entire
 * import — the larger the chunk, the worse that trade gets. Halving costs at most
 * log2(chunk) extra attempts, and only when something is actually wrong, so the happy path
 * (`write` never throws) costs exactly the one call it always cost — no narrowing statement
 * is ever issued unless a write actually fails.
 *
 * A chunk where every row is bad degrades to one statement per row (the base case fires for
 * every leaf), and this function does not cap that on its own: capping the *split* would
 * just reintroduce "one bad row (or a few) costs a batch of good ones" at whatever size the
 * cap picked, and 250 one-row statements is not, by itself, a cost worth guarding against —
 * the plain multi-row happy path already dominates real traffic.
 *
 * What actually needs a limit is not the splitting but the *marking*: a chunk that fails
 * every row for a genuine, scattered reason should mark every row failed, but a chunk that
 * fails every row because of one systemic fault (a dropped connection, a timeout) should not
 * — that isolates nothing, it just converts a retryable failure into permanent per-row data
 * loss. That distinction is the caller's to make, not this function's — see
 * `MAX_ROW_FAILURES_PER_CHUNK` and the `onBadRow` built in `runImportJob`, which throws
 * instead of marking once its budget is spent. `writeWithNarrowing` does not catch what its
 * own `onBadRow` throws (the call sits in the `catch` block below, not inside a nested
 * `try`), so that throw always escapes all the way out, at any recursion depth.
 *
 * `write` and `onBadRow` are expected to apply their own side effects (accounting, mapping
 * row ids to contact ids, etc.) as part of running — `writeWithNarrowing` itself only
 * decides how many rows to include in each attempt, never what a successful or failed write
 * means to the caller.
 */
async function writeWithNarrowing<T>(
  items: T[],
  write: (batch: T[]) => Promise<void>,
  onBadRow: (item: T, err: unknown) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  try {
    await write(items);
  } catch (err) {
    if (items.length === 1) {
      await onBadRow(items[0], err);
      return;
    }
    const mid = Math.ceil(items.length / 2);
    // Sequential, not `Promise.all`: the second half's headroom-aware admission (the create
    // path) depends on the first half having already updated `headroom`, so these two calls
    // must not race.
    await writeWithNarrowing(items.slice(0, mid), write, onBadRow);
    await writeWithNarrowing(items.slice(mid), write, onBadRow);
  }
}

/** Row-level reason recorded when narrowing isolates this row as the cause of a chunk failure. */
async function markRowFailed(row: PendingRow, err: unknown) {
  const db = await getDb();
  await db
    .update(importJobRows)
    .set({
      status: "failed",
      errorMessage: (err instanceof Error ? err.message : "Row failed").slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(importJobRows.id, row.id));
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
/** The running totals `accumulatedStats` folds into a job's persisted `stats`. Grouped into
 *  one object rather than four positional args, now that the reminders/interactions counts
 *  (Task 15's review) joined `skipped`/`blockedByPlan` — a positional signature that already
 *  needed a doc comment to keep its call sites straight is the wrong shape to keep growing. */
type RunningTotals = {
  skipped: number;
  blockedByPlan: number;
  failedRows: number;
  interactionsLogged: number;
  remindersCreated: number;
};

function accumulatedStats(
  latestStats: ImportStats,
  jobStart: number,
  totals: RunningTotals
): ImportStats {
  return {
    ...latestStats,
    skipped: totals.skipped,
    blockedByPlan: totals.blockedByPlan,
    failedRows: totals.failedRows,
    interactionsLogged: totals.interactionsLogged,
    remindersCreated: totals.remindersCreated,
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

  // Everything below runs inside this try so the `finally` is the *only* thing any exit
  // path — an early return, a caught failure, cancellation mid-loop, or a bug that throws
  // past both inner try/catches — has to get right to stop the counter. `startQueryCount()`
  // above already armed the module-global counter; leaving it armed past this invocation
  // silently misattributes whatever unrelated work runs next in this process to *this*
  // invocation's count, until some future `startQueryCount()` finally zeroes it again. A
  // structural guarantee here is deliberately preferred over "every return must remember to
  // call `stopQueryCount()`" as a rule to follow: a documented rule the code doesn't enforce
  // is worse than an undocumented gap, because the next reader trusts the comment instead of
  // checking every exit path against it. `stopQueryCount()` is safe to call more than once
  // per invocation (calling it again after it's already stopped just returns the same frozen
  // count), so this `finally` composes cleanly with the explicit calls below that capture the
  // count into a failed job's own `stats` before this backstop re-stops it.
  try {
    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    if (!importRow) return;
    // The self-continuation route and the stalled-job cron both re-dispatch by `importId`
    // alone, so re-running an already-finished or since-deleted job is an expected, everyday
    // occurrence here, not an edge case.
    if (["completed", "failed", "cancelled"].includes(importRow.status)) return;

    // Resolved once, from the type recorded on the job row. Import kinds with no server-side
    // runner (the client-driven ones) resolve to `null` and are left alone rather than being
    // pushed through a loop that has no idea what their payloads mean.
    const adapter = getAdapter(importRow.importType);
    if (!adapter) return;
    const createsContacts = adapter.createsContacts !== false;
    // See `ImportAdapter.matchConfidence`'s doc comment for why this floor is not always
    // `DUPLICATE_MERGE_CONFIDENCE`.
    const matchConfidence = adapter.matchConfidence ?? DUPLICATE_MERGE_CONFIDENCE;

    const userId = importRow.userId;

    // Hoisted above the setup try/catch (rather than declared where they're first mutated,
    // further down) so that catch can fold this invocation's query cost into the failed
    // job's own `stats` via `accumulatedStats` — a failed import's cost up to the point of
    // failure is arguably the most interesting number it has, particularly for the
    // systemic-fault case `MAX_ROW_FAILURES_PER_CHUNK` exists to catch.
    let skippedTotal = importRow.stats?.skipped ?? 0;
    let blockedByPlanTotal = importRow.stats?.blockedByPlan ?? 0;
    // Seeded from the persisted value for the same reason as the counters around it: a
    // self-continuing job must report rows isolated by *earlier* invocations too, not just
    // this one's. See `ImportStats.failedRows`.
    let failedRowsTotal = importRow.stats?.failedRows ?? 0;
    let interactionsLoggedTotal = importRow.stats?.interactionsLogged ?? 0;
    let remindersCreatedTotal = importRow.stats?.remindersCreated ?? 0;
    // Refreshed every loop pass from the row this job's own writes are updating, so the
    // final completion update below folds in whatever another process wrote to `stats`
    // (e.g. Gmail-scan-style concurrent fields) instead of the snapshot from job start,
    // which a self-continuing job would otherwise stomp back to a stale value.
    let latestStats = importRow.stats ?? {};

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
          xHandle: true,
          company: true,
          title: true,
        },
      });
      duplicateIndex = buildDuplicateIndex(existingContacts);
      companyResolve = await createCompanyResolver(userId);
    } catch (err) {
      await failImport(
        importId,
        err,
        accumulatedStats(latestStats, jobStart, {
          skipped: skippedTotal,
          blockedByPlan: blockedByPlanTotal,
          failedRows: failedRowsTotal,
          interactionsLogged: interactionsLoggedTotal,
          remindersCreated: remindersCreatedTotal,
        })
      );
      return;
    }

    let contactsCreated = importRow.contactsCreated ?? 0;
    let contactsUpdated = importRow.contactsUpdated ?? 0;
    let duplicatesFound = importRow.duplicatesFound ?? 0;
    let rowsProcessed = importRow.rowsProcessed ?? 0;
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
              stats: accumulatedStats(latestStats, jobStart, {
                skipped: skippedTotal,
                blockedByPlan: blockedByPlanTotal,
                failedRows: failedRowsTotal,
                interactionsLogged: interactionsLoggedTotal,
                remindersCreated: remindersCreatedTotal,
              }),
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
          payload: ImportJobRowPayload | string;
          status: string;
          contact_id: string | null;
        }>(claimed).map((row) => ({
          id: row.id,
          importId,
          userId,
          rowIndex: row.row_index,
          // `db.execute` is a raw driver call, so it skips Drizzle's own jsonb column mapping
          // (`PgJsonb.mapFromDriverValue`), which defensively `JSON.parse`s a string payload
          // rather than assuming the driver already decoded it. Matched here for the same
          // reason: whether `jsonb` comes back pre-parsed or as text is driver-specific, and
          // getting this wrong would silently break every downstream `adapter.identity()`
          // call rather than throw.
          payload: (typeof row.payload === "string"
            ? JSON.parse(row.payload)
            : row.payload) as ImportJobRowPayload,
          status: row.status,
          contactId: row.contact_id,
        }));

        // `UPDATE ... RETURNING` does not guarantee its output is in the claiming subquery's
        // `ORDER BY row_index` — that clause only bounds *which* rows are claimed, not the
        // order they come back in. Classification below is order-independent, but
        // `createContactsBulkForUser` admits from the front of `toCreate` under the plan cap,
        // and `toCreate` is built by iterating `pendingRows` — so an unsorted claim would make
        // "which contacts get admitted" depend on arbitrary RETURNING order instead of file
        // order. Sorting once here is what makes every "from the front" guarantee downstream
        // (the cap, and narrowing's recursive front/back split below) actually mean file order.
        pendingRows.sort((a, b) => a.rowIndex - b.rowIndex);

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

          if (dups[0] && dups[0].confidence >= matchConfidence) {
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
        //
        // Accumulated with `push` rather than a single assignment because `writeWithNarrowing`
        // can call this batch's write callback more than once (once per surviving sub-batch
        // after a poison row is isolated), and each successful sub-batch can contribute its
        // own cap-refused tail.
        const planBlockedRows: PendingRow[] = [];

        // Shared across both narrowing calls below (create and merge): a systemic fault can
        // surface from either bulk write, and this chunk's budget is one pool, not two. See
        // `MAX_ROW_FAILURES_PER_CHUNK` for the reasoning.
        let chunkRowFailures = 0;
        const onBadRow = async (item: { row: PendingRow }, err: unknown) => {
          if (chunkRowFailures >= MAX_ROW_FAILURES_PER_CHUNK) {
            // Marking this row would be the budget's (MAX_ROW_FAILURES_PER_CHUNK + 1)th failure
            // this chunk. That many failures in one chunk looks like a systemic fault, not
            // scattered bad data — escape narrowing entirely rather than keep marking rows
            // `failed` one at a time. Re-thrown, not swallowed: `writeWithNarrowing` never
            // catches what its own `onBadRow` throws (see its base case), so this propagates
            // straight out to `runImportJob`'s own try/catch.
            throw err instanceof Error ? err : new Error(String(err));
          }
          chunkRowFailures++;
          // `chunkRowFailures` resets per chunk (it is the budget); `failedRowsTotal` does
          // not — it is what the user is eventually told, so it accumulates across every
          // chunk and every invocation. See `ImportStats.failedRows`.
          failedRowsTotal++;
          await markRowFailed(item.row, err);
        };

        if (toCreate.length > 0) {
          await writeWithNarrowing(
            toCreate,
            async (batch) => {
              const created = await createContactsBulkForUser(
                userId,
                batch.map((item) => item.input),
                companyResolve,
                { skipRevalidate: true, skipEmbedding: true, headroom }
              );
              // Only reached once the insert has actually succeeded — a batch whose insert
              // throws is caught by `writeWithNarrowing`, which retries smaller slices of the
              // same `batch`, so nothing here may run for a batch that didn't really write.
              created.forEach((contact, i) => {
                addToDuplicateIndex(duplicateIndex, contact);
                contactIdByRowId.set(batch[i].row.id, contact.id);
                touchedContactIds.push(contact.id);
              });
              contactsCreated += created.length;
              if (headroom !== null) headroom = Math.max(0, headroom - created.length);

              if (created.length < batch.length) {
                planBlockedRows.push(...batch.slice(created.length).map((item) => item.row));
                blockedByPlanTotal += batch.length - created.length;
              }
            },
            onBadRow
          );
        }

        if (toUpdate.length > 0) {
          await writeWithNarrowing(
            toUpdate,
            async (batch) => {
              await bulkMergeContactsForUser(
                userId,
                batch.map((item) => ({ contactId: item.contactId, input: item.input })),
                companyResolve
              );
              for (const item of batch) {
                contactIdByRowId.set(item.row.id, item.contactId);
                touchedContactIds.push(item.contactId);
              }
              contactsUpdated += batch.length;
              duplicatesFound += batch.length;
            },
            onBadRow
          );
        }

        // One insert for the whole chunk, not one per row: an importer that logs a meeting or
        // a message per row is exactly the shape that made this pipeline per-row in the first
        // place. Targets the soft-unique (user_id, external_id) index the interactions table
        // already carries for import dedupe, so a retried chunk re-inserting rows it already
        // wrote updates them in place rather than failing or silently ignoring new data.
        //
        // `onConflictDoUpdate`, not `onConflictDoNothing` — Task 10 originally left this
        // untargeted-DoNothing (keeping the *stale* row on a conflict), and Task 15's review
        // caught that this was a real regression for calendar specifically: the per-row
        // importer it replaced had an explicit `if (prior) -> UPDATE` branch, so a re-synced
        // event whose *time* changed used to pick up the new date and now didn't. Fixed by
        // updating on conflict instead of re-documenting the gap.
        //
        // For the other `interactions()` producer, LinkedIn messages: its `externalId`
        // (`li-msg:conv:date:hash(content)` — see `linkedInMessageExternalId` in
        // `src/actions/imports.ts`) is itself a function of the date and content, so a message
        // whose date or content changed produces a *different* id and never conflicts at all
        // — it's a plain insert. The only way to hit the conflict branch for messages is a
        // byte-identical re-import.
        //
        // That used to make the branch a genuine no-op, because every column in the `set` was
        // already derived from data the id hashes. `direction` broke that, deliberately: it is
        // NOT hashed into the id, so a byte-identical re-import now writes a value that was
        // previously NULL. That is the entire backfill mechanism for message direction, which
        // is otherwise unrecoverable — the sender was never persisted, so re-uploading the
        // export is the only way to learn it. Drop `direction` from this `set` and the
        // re-upload silently accomplishes nothing.
        //
        // The re-import scenario in `smoke-import-engine.ts` (interaction count unchanged
        // across two runs) still holds — this updates rows, it does not add them.
        //
        // `targetWhere` mirrors the partial index's own `WHERE external_id IS NOT NULL` —
        // Postgres requires the ON CONFLICT clause to match a partial unique index's
        // predicate exactly, or it won't recognize the index as a valid arbiter.
        //
        // `.returning()` feeds `interactionsLoggedTotal` below (see its own comment) — every
        // row DO UPDATE touches is returned, whether it inserted or updated, so the count
        // reflects "interactions this run wrote," not "brand-new rows only." (Called bare, not
        // `.returning({ id })` — passing an explicit field selector here defeats Drizzle's
        // overload resolution after `.onConflictDoUpdate()` in this TS version; bare is
        // functionally identical for a count, just returns every column instead of one.)
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
            // `ON CONFLICT DO UPDATE` — unlike the `DO NOTHING` this replaced — errors if a
            // single INSERT's own VALUES list would affect the same conflict target twice
            // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), rather than
            // silently letting the second row's insert be swallowed. Two rows in this same
            // chunk *can* share an externalId: for calendar, two attendee entries for one
            // event that don't share an exact resolved identity (e.g. one email-only, one
            // name-only — see `personIdentityKey` in `calendar-import.ts` for that limit) can
            // still both match the *same* existing contact via the duplicate index, producing
            // the same `cal:eventUid:contactId`. Deduping here (last one in row order wins)
            // keeps the batch always valid without a per-row existence check; it's a
            // safety net for adapters, not a substitute for deduping at the source the way
            // `peopleFromEvent` does for calendar's actual, expected case (the organizer also
            // listed as an attendee).
            const byExternalId = new Map<string, InteractionInsert>();
            const noExternalId: InteractionInsert[] = [];
            for (const row of interactionRows) {
              if (row.externalId) byExternalId.set(row.externalId, row);
              else noExternalId.push(row);
            }
            const dedupedInteractionRows = [...byExternalId.values(), ...noExternalId];

            const loggedInteractions = await db
              .insert(interactions)
              .values(dedupedInteractionRows)
              .onConflictDoUpdate({
                target: [interactions.userId, interactions.externalId],
                targetWhere: sql`${interactions.externalId} is not null`,
                set: {
                  interactionDate: sql`excluded.interaction_date`,
                  rawNotes: sql`excluded.raw_notes`,
                  aiSummary: sql`excluded.ai_summary`,
                  topics: sql`excluded.topics`,
                  source: sql`excluded.source`,
                  // `coalesce`, not a bare overwrite: a resumed pre-change job row carries no
                  // direction, and letting its NULL clobber a direction an earlier re-upload
                  // established would undo the backfill it just did.
                  direction: sql`coalesce(excluded.direction, ${interactions.direction})`,
                },
              })
              .returning();
            interactionsLoggedTotal += loggedInteractions.length;
          }
        }

        // Adapter-specific reminders (today, only the calendar adapter's post-meeting
        // follow-ups). A second bulk insert, not folded into the one above — `reminders` and
        // `interactions` are different tables. Unlike `interactions.externalId`, `reminders`
        // has no soft-unique column to lean an `onConflictDoNothing()` on, so this does its
        // own bulk dedupe: one `SELECT` scoped to the contacts this chunk actually touched,
        // then an exact (contactId, description) match against the candidates. That pair is
        // deterministic per adapter row (same event + same contact -> same description), so a
        // re-uploaded file reproduces byte-identical candidates and they're filtered out
        // rather than inserted a second time — no per-row existence check needed.
        if (adapter.reminders) {
          const reminderRows: ReminderInsert[] = [];
          for (const row of pendingRows) {
            const contactId = contactIdByRowId.get(row.id);
            if (!contactId) continue;
            reminderRows.push(
              ...adapter.reminders(row.payload as ImportJobRowPayload, contactId, userId)
            );
          }
          if (reminderRows.length > 0) {
            const candidateContactIds = [
              ...new Set(
                reminderRows
                  .map((r) => r.contactId)
                  .filter((cid): cid is string => typeof cid === "string")
              ),
            ];
            const existingReminders =
              candidateContactIds.length > 0
                ? await db.query.reminders.findMany({
                    where: and(
                      eq(reminders.userId, userId),
                      inArray(reminders.contactId, candidateContactIds)
                    ),
                    columns: { contactId: true, description: true },
                  })
                : [];
            const existingKeys = new Set(
              existingReminders.map((r) => `${r.contactId}::${r.description ?? ""}`)
            );
            const newReminders = reminderRows.filter(
              (r) => !existingKeys.has(`${r.contactId}::${r.description ?? ""}`)
            );
            if (newReminders.length > 0) {
              const insertedReminders = await db
                .insert(reminders)
                .values(newReminders)
                .returning();
              remindersCreatedTotal += insertedReminders.length;
            }
          }
        }

        for (const id of touchedContactIds) allTouchedContactIds.add(id);

        const blockedRowIds = new Set(planBlockedRows.map((row) => row.id));
        // Every row that actually got a contact id — via a successful create or a successful
        // merge — is in `contactIdByRowId`, and nothing else is: a cap-refused row is never
        // passed to `createContactsBulkForUser` for a batch beyond `created.length`, and a
        // narrowed-out poison row's batch throws before this map is ever touched for it. So
        // this is simply every row this chunk actually wrote, independent of how narrowing
        // split the batches to get there — no need to separately subtract blocked/failed rows
        // from `toCreate`/`toUpdate` the way a pre-narrowing "all or nothing" write allowed.
        const doneRowIds = [...contactIdByRowId.keys()];

        // These three writes touch disjoint row sets — blockedRowIds is a subset of
        // toCreate's rows that createContactsBulkForUser refused, doneRowIds is every row that
        // was actually created or merged, and toSkip is rows filtered out before either bulk
        // write ran. (Rows narrowing isolated as poison are already terminal — `markRowFailed`
        // wrote them directly — and appear in none of these three sets.) So there is nothing
        // to gain from running these three writes one after another.
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

        // Every row this chunk claimed, not just the ones that produced a contact.
        //
        // `toCreate.length + toUpdate.length` was carried verbatim from the LinkedIn
        // connections processor, where nearly every row creates or merges so the
        // undercount was invisible. It is not invisible for the four import types that
        // joined the engine afterwards: Google/Outlook previously wrote `rows.length`,
        // messages wrote `messagesImported`, and calendar wrote `chunkEvents.length` —
        // all four counted every row. Calendar is the worst case, because `totalRows`
        // counts (event, attendee) pairs while only *matched* attendees ever reach
        // `toUpdate`: a file where 40% of attendees are known would visibly stall the
        // progress bar at 40% and make the cancel message ("N of M kept") wrong too.
        //
        // Every claimed row is terminal by the time control reaches here — created or
        // merged (`contactIdByRowId`), refused by the plan cap (`planBlockedRows`),
        // classified out (`toSkip`), or isolated by narrowing (`markRowFailed`) — and
        // `pendingRows` is exactly the union of those, so counting the claim is both the
        // simplest and the only expression that cannot drift as new terminal states are
        // added. Rows left `processing` by a chunk that threw are never counted, because
        // that path returns via `failImport` before reaching this line, and they are
        // re-claimed (and then counted once) on the next attempt.
        rowsProcessed += pendingRows.length;

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
              failedRows: failedRowsTotal,
              interactionsLogged: interactionsLoggedTotal,
              remindersCreated: remindersCreatedTotal,
            },
            errorMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(imports.id, importId));
      }
    } catch (err) {
      await failImport(
        importId,
        err,
        accumulatedStats(latestStats, jobStart, {
          skipped: skippedTotal,
          blockedByPlan: blockedByPlanTotal,
          failedRows: failedRowsTotal,
          interactionsLogged: interactionsLoggedTotal,
          remindersCreated: remindersCreatedTotal,
        })
      );
      return;
    }

    await db
      .update(imports)
      .set({
        status: "completed",
        stats: accumulatedStats(latestStats, jobStart, {
          skipped: skippedTotal,
          blockedByPlan: blockedByPlanTotal,
          failedRows: failedRowsTotal,
          interactionsLogged: interactionsLoggedTotal,
          remindersCreated: remindersCreatedTotal,
        }),
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importId));

    // The per-row confirm actions this engine replaced (Google/Outlook contacts, and before
    // them LinkedIn connections) each refreshed outreach suggestions once the import finished,
    // non-fatally — a stray suggestion-generation bug was never worth failing an otherwise-
    // successful import over. This is that same finalization step, now owned by the engine
    // instead of duplicated per import type. It incidentally gives LinkedIn CSV imports (which
    // never called it, in either the old per-row path or here until now) the same refresh
    // Google/Outlook contacts and every other import type already had — a deliberate
    // improvement, not scope creep: it's the one finalization step every import type is
    // supposed to get, not something specific to this task's two new adapters.
    await refreshOutreachSuggestions(importRow.userId).catch(() => null);

    // Adapter-specific once-per-job finalization (see `ImportAdapter.finalize`) — e.g. the
    // LinkedIn messages adapter's AI enrichment pass. Runs over every contact this job
    // touched across every chunk, once, not per chunk; non-fatal like the two calls above.
    if (adapter.finalize) {
      await adapter.finalize(importRow.userId, [...allTouchedContactIds]).catch(() => null);
    }

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
  } finally {
    stopQueryCount();
  }
}

/**
 * Above this many touched contacts, skip per-contact revalidation entirely — the list and
 * dashboard paths above already cover what a user can actually be looking at.
 */
const PER_CONTACT_REVALIDATE_LIMIT = 50;

/** Exported so the Gmail recruiter scan runner shares one job-failure path. */
export async function failImport(
  importId: string,
  err: unknown,
  stats?: ImportStats
) {
  const message = err instanceof Error ? err.message : "Import failed";
  const db = await getDb();
  await db
    .update(imports)
    .set({
      status: "failed",
      errorMessage: message.slice(0, 500),
      updatedAt: new Date(),
      // Optional and additive: the Gmail recruiter scan runner shares this failure path but
      // has no query-count stats of its own to report, so it calls this with the two-arg
      // form and `stats` stays undefined — Drizzle's partial `.set()` just omits the column
      // from the update rather than nulling out whatever `stats` the row already carried.
      ...(stats ? { stats } : {}),
    })
    .where(eq(imports.id, importId));
}
