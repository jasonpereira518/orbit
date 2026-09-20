import { and, asc, eq, inArray } from "drizzle-orm";
import { classifyAiError, friendlyError } from "@/lib/errors";
import { getDb } from "@/db";
import {
  gmailConnections,
  imports,
  importJobRows,
  userRecruiterLinks,
  isGmailSenderRow,
  type GmailSenderRowPayload,
  type ImportStats,
} from "@/db/schema";
import { internalFetch } from "@/lib/internal-auth";
import { failImport, truncateStoredError } from "@/lib/import-job-processor";
import {
  buildRecruiterQuery,
  fetchGmailHeaders,
  fetchGmailMessages,
  firmFromEmail,
  getValidAccessToken,
  listGmailMessagePage,
  looksLikeRecruiter,
  parseFromHeader,
  type GmailMessageContent,
} from "@/lib/gmail";
import {
  RECRUITER_CONFIDENCE_FLOOR,
  RECRUITER_SYSTEM,
  buildRecruiterUserPrompt,
  classifyRecruiterSender,
  recruiterResultFromContent,
  type RecruiterScanResult,
} from "@/lib/recruiter-scan";
import { submitAiBatch } from "@/lib/ai-batch";
import {
  markScanCompleted,
  resolveScanWindow,
} from "@/lib/recruiter-scan-state";
import {
  ensureUserLink,
  isViewerSharing,
  upsertCanonicalRecruiter,
} from "@/lib/recruiters";
import { reportError } from "@/lib/report-error";

export { GMAIL_SCAN_IMPORT_TYPE } from "@/lib/gmail-scan-type";

/**
 * Small on purpose. Each row is a handful of Gmail body fetches plus one LLM call, so
 * the LinkedIn runner's chunk of 40 would blow the time budget in a single pass.
 */
const CHUNK_SIZE = 8;
/**
 * Senders per submitted batch. Larger than the inline chunk because a batch costs one round
 * trip however many requests it holds, and capped by what `submitAiBatch` accepts.
 */
const SCAN_BATCH_SIZE = 50;
/** Same headroom as the LinkedIn runner: stay under the 300s ceiling with room to hand off. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;
const DISCOVERY_PAGE_SIZE = 200;
/** Ids kept per sender. The classifier reads the most recent few; the rest are for counts. */
const MAX_IDS_PER_SENDER = 12;
/**
 * Ceiling on candidate senders per scan. A mailbox with thousands of recruiter-ish
 * senders would otherwise bill the user's own API key for thousands of LLM calls.
 * Reaching it is reported in the UI, never silently truncated.
 */
const MAX_CANDIDATE_SENDERS = 400;

/** Senders failing back to back before the scan gives up rather than "completing". */
export const MAX_CONSECUTIVE_SENDER_FAILURES = 5;

/**
 * Failure kinds that mean the KEY is the problem, not the sender. Every later sender would
 * fail the same way, so the scan stops at the first — and, crucially, never reaches
 * `markScanCompleted`, which would step the watermark over mail it never read.
 */
export const SCAN_KEY_PROBLEM_COPY = {
  auth: "Your AI provider didn’t accept your API key — check it in Settings, then scan again",
  quota:
    "Your AI provider says your account is out of credit — top up with them, then scan again",
  model_unavailable:
    "Your AI model isn’t available — pick another in Settings, then scan again",
} as const;

export const SCAN_CONSECUTIVE_FAILURES_COPY =
  "The scan stopped after several conversations in a row couldn’t be read — try again in a while";

function scanAbortReason(err: unknown): string | null {
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    // Provider copy that is already Orbit's own words passes through; raw text does not.
    return friendlyError(err, SCAN_KEY_PROBLEM_COPY[kind]);
  }
  return null;
}

/** Gmail, the classifier and the continuation kick — injectable so the loop is testable. */
export type ScanDeps = {
  getAccessToken: (
    userId: string,
    opts?: { minValidityMs?: number },
  ) => Promise<string>;
  listPage: typeof listGmailMessagePage;
  fetchHeaders: typeof fetchGmailHeaders;
  fetchMessages: typeof fetchGmailMessages;
  classify: typeof classifyRecruiterSender;
  /** Submits the batch. Injectable so the smoke suite can run both paths. */
  submit: typeof submitAiBatch;
  continueLater: (importId: string) => Promise<void>;
};

async function patchStats(importId: string, patch: Partial<ImportStats>) {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: eq(imports.id, importId),
  });
  if (!row) return;
  await db
    .update(imports)
    .set({ stats: { ...(row.stats || {}), ...patch }, updatedAt: new Date() })
    .where(eq(imports.id, importId));
}

/** Kick a fresh invocation so the remaining work continues past this function's ceiling. */
async function scheduleContinuation(importId: string) {
  try {
    await internalFetch(`/api/imports/${importId}/continue`, {
      method: "POST",
    });
  } catch (err) {
    // Best-effort — the process-stalled cron picks the job back up either way.
    reportError(err, {
      where: "job.gmail-scan.continuation-kick",
      level: "warning",
      extra: { importId },
    });
  }
}

const DEFAULT_SCAN_DEPS: ScanDeps = {
  getAccessToken: getValidAccessToken,
  listPage: listGmailMessagePage,
  fetchHeaders: fetchGmailHeaders,
  fetchMessages: fetchGmailMessages,
  classify: classifyRecruiterSender,
  submit: submitAiBatch,
  continueLater: scheduleContinuation,
};

/**
 * Phase A: walk the mailbox and turn recruiter-ish senders into work rows.
 *
 * Resumable at page granularity. Grouping happens against rows already in the DB rather
 * than an in-memory map, because a continuation starts with an empty heap and would
 * otherwise create a second row for a sender it had already seen.
 *
 * Returns false when it ran out of time and has scheduled its own continuation.
 */
async function runDiscovery(
  importId: string,
  userId: string,
  accessToken: string,
  jobStart: number,
  scanAfter: Date,
  deps: ScanDeps,
): Promise<boolean> {
  const db = await getDb();

  const existing = await db.query.importJobRows.findMany({
    where: eq(importJobRows.importId, importId),
  });
  const byEmail = new Map<
    string,
    { id: string; payload: GmailSenderRowPayload }
  >();
  for (const row of existing) {
    if (isGmailSenderRow(row.payload)) {
      byEmail.set(row.payload.email, { id: row.id, payload: row.payload });
    }
  }

  const startRow = await db.query.imports.findFirst({
    where: eq(imports.id, importId),
  });
  let pageToken = startRow?.stats?.gmailPageToken ?? null;
  let scanned = startRow?.stats?.messagesScanned ?? 0;

  while (true) {
    if (Date.now() - jobStart > TIME_BUDGET_MS) {
      await patchStats(importId, {
        gmailPageToken: pageToken,
        messagesScanned: scanned,
        candidateSenders: byEmail.size,
      });
      await deps.continueLater(importId);
      return false;
    }

    const page = await deps.listPage(accessToken, {
      // Bounded by the resolved window and stripped of ATS/job-board mail server-side.
      // Both are free at Gmail and remove work that would otherwise cost a metadata fetch
      // and, past the prefilter, an LLM call on the user's own key.
      query: buildRecruiterQuery({ after: scanAfter }),
      pageToken,
      maxResults: DISCOVERY_PAGE_SIZE,
    });

    if (page.messages.length > 0) {
      const headers = await deps.fetchHeaders(accessToken, page.messages);
      scanned += page.messages.length;

      for (const msg of headers) {
        if (
          !looksLikeRecruiter({
            from: msg.from,
            subject: msg.subject,
            snippet: msg.snippet,
          })
        ) {
          continue;
        }
        const parsed = parseFromHeader(msg.from);
        if (!parsed) continue;

        const found = byEmail.get(parsed.email);
        if (found) {
          if (found.payload.messageIds.length < MAX_IDS_PER_SENDER) {
            found.payload.messageIds.push(msg.id);
            await db
              .update(importJobRows)
              .set({ payload: found.payload, updatedAt: new Date() })
              .where(eq(importJobRows.id, found.id));
          }
          continue;
        }

        if (byEmail.size >= MAX_CANDIDATE_SENDERS) continue;

        const payload: GmailSenderRowPayload = {
          kind: "gmail_sender",
          email: parsed.email,
          name: parsed.name.replace(/\b\w/g, (c) => c.toUpperCase()),
          firm: firmFromEmail(parsed.email),
          messageIds: [msg.id],
        };
        const [inserted] = await db
          .insert(importJobRows)
          .values({
            importId,
            userId,
            rowIndex: byEmail.size,
            payload,
            status: "pending",
          })
          .returning();
        byEmail.set(parsed.email, { id: inserted.id, payload });
      }
    }

    pageToken = page.nextPageToken;
    await patchStats(importId, {
      gmailPageToken: pageToken,
      messagesScanned: scanned,
      candidateSenders: byEmail.size,
    });

    if (!pageToken) break;
  }

  await db
    .update(imports)
    .set({ totalRows: byEmail.size, updatedAt: new Date() })
    .where(eq(imports.id, importId));
  await patchStats(importId, {
    discoveryComplete: true,
    gmailPageToken: null,
    messagesScanned: scanned,
    candidateSenders: byEmail.size,
  });
  return true;
}

/** Phase B: classify and summarize one sender, writing through to the recruiter tables. */
/** What applying a verdict needs from the mail, so a batched answer need not re-read Gmail. */
export type SenderMailMeta = {
  dates: number[];
  threadId: string | null;
  messageCount: number;
};

function mailMetaOf(
  payload: GmailSenderRowPayload,
  messages: GmailMessageContent[],
): SenderMailMeta {
  return {
    dates: messages
      .map((m) => m.internalDate)
      .filter((d): d is number => typeof d === "number"),
    threadId: messages[0]?.threadId || null,
    messageCount: payload.messageIds.length,
  };
}

/**
 * The write half: a verdict becomes a recruiter the user is linked to, or nothing.
 *
 * Split from the classification so a batched answer lands exactly like an inline one. Takes
 * the mail's dates and thread id rather than the messages, because a batch is applied hours
 * later, when the Gmail token that read them may be long gone.
 */
export async function applyRecruiterVerdict(
  userId: string,
  payload: GmailSenderRowPayload,
  meta: SenderMailMeta,
  result: RecruiterScanResult,
): Promise<"recruiter" | "rejected"> {
  if (!result.isRecruiter || result.confidence < RECRUITER_CONFIDENCE_FLOOR) {
    return "rejected";
  }

  // The sender's address came from THIS user's inbox; it lands on a shared row only when
  // the row is new (this user is its creator) or this user shares.
  const recruiter = await upsertCanonicalRecruiter(
    {
      fullName: result.fullName || payload.name,
      firm: result.firm || payload.firm,
      email: payload.email,
      specialty: result.rolesDiscussed,
    },
    { contributePii: await isViewerSharing(userId), createdByUserId: userId },
  );

  await ensureUserLink({
    userId,
    recruiterId: recruiter.id,
    status: "contacted",
    source: "gmail",
    // From THIS user's mailbox: it belongs on their own link whether or not they share.
    email: payload.email,
  });

  const db = await getDb();
  await db
    .update(userRecruiterLinks)
    .set({
      aiSummary: result.summary,
      companiesMentioned: result.companiesMentioned,
      rolesDiscussed: result.rolesDiscussed,
      emailCount: meta.messageCount,
      firstEmailAt: meta.dates.length
        ? new Date(Math.min(...meta.dates))
        : null,
      lastEmailAt: meta.dates.length ? new Date(Math.max(...meta.dates)) : null,
      gmailThreadId: meta.threadId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userRecruiterLinks.userId, userId),
        eq(userRecruiterLinks.recruiterId, recruiter.id),
      ),
    );

  return "recruiter";
}

async function processSender(
  userId: string,
  payload: GmailSenderRowPayload,
  accessToken: string,
  deps: ScanDeps,
): Promise<"recruiter" | "rejected"> {
  const messages = await deps.fetchMessages(
    accessToken,
    payload.messageIds.slice(0, 5),
  );
  if (messages.length === 0) return "rejected";

  const result = await deps.classify(userId, {
    senderName: payload.name,
    senderEmail: payload.email,
    firmGuess: payload.firm,
    messages,
  });

  return applyRecruiterVerdict(
    userId,
    payload,
    mailMetaOf(payload, messages),
    result,
  );
}

/** A sender whose classification is out with a provider, waiting on a batch. */
export const SCAN_ROW_QUEUED = "queued";

/** What a submitted classification batch needs to map its answers back onto. */
export type RecruiterBatchPayload = {
  importId: string;
  items: Array<{
    customId: string;
    rowId: string;
    payload: GmailSenderRowPayload;
    meta: SenderMailMeta;
  }>;
};

/**
 * Completes a scan once no sender is left unread — including any still out with a provider.
 *
 * Only a job that reaches `completed` advances the mailbox watermark, so this is also what
 * stops a scan from stepping over senders whose batch has not answered yet. Safe to call
 * from the runner and from the batch sweep; the first one to find nothing outstanding wins.
 */
export async function finalizeRecruiterScanIfDone(
  importId: string,
): Promise<boolean> {
  const db = await getDb();
  const importRow = await db.query.imports.findFirst({
    where: eq(imports.id, importId),
  });
  if (!importRow || importRow.status !== "processing") return false;

  const outstanding = await db.query.importJobRows.findMany({
    where: and(
      eq(importJobRows.importId, importId),
      inArray(importJobRows.status, ["pending", SCAN_ROW_QUEUED]),
    ),
    columns: { id: true },
    limit: 1,
  });
  if (outstanding.length > 0) return false;

  const done = await db.query.importJobRows.findMany({
    where: eq(importJobRows.importId, importId),
    columns: { id: true },
  });

  await db
    .update(imports)
    .set({
      status: "completed",
      rowsProcessed: done.length,
      updatedAt: new Date(),
    })
    .where(eq(imports.id, importId));

  // Only a job that reached `completed` may advance the watermark. A failed or cancelled
  // scan leaves it where it was, so the next run re-reads the window it never finished
  // rather than stepping over the messages it never got to.
  await markScanCompleted(importRow.userId, {
    startedAt: importRow.stats?.scanStartedAt
      ? new Date(importRow.stats.scanStartedAt)
      : new Date(),
    wasFull: importRow.stats?.scanIsFull === true,
  });

  // Feeds the "last synced" line in the connection status.
  await db
    .update(gmailConnections)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(gmailConnections.userId, importRow.userId));
  return true;
}

/**
 * Processes a Gmail recruiter scan in time-boxed chunks.
 *
 * Safe to call repeatedly — self-continuation, the stalled-job cron, and a manual retry
 * all land here, and it re-reads job and row state from the DB every iteration rather
 * than assuming it is starting fresh.
 */
export async function runGmailRecruiterScanJob(
  importId: string,
  deps: ScanDeps = DEFAULT_SCAN_DEPS,
): Promise<void> {
  const db = await getDb();
  const jobStart = Date.now();

  const importRow = await db.query.imports.findFirst({
    where: eq(imports.id, importId),
  });
  if (!importRow) return;
  if (["completed", "failed", "cancelled"].includes(importRow.status)) return;

  const userId = importRow.userId;

  let accessToken: string;
  try {
    // Valid for the whole invocation: a token minted with two minutes left would expire
    // half-way through a page and read as a run of empty messages.
    accessToken = await deps.getAccessToken(userId, {
      minValidityMs: TIME_BUDGET_MS + 60_000,
    });
  } catch (err) {
    await failImport(importId, err);
    return;
  }

  // Resolve the window once, on the first invocation, and freeze it into the job. Later
  // invocations read it back rather than re-deriving it, so every page of a multi-invocation
  // scan is drawn from the same slice of the mailbox.
  let scanAfter: Date;
  let scanIsFull: boolean;
  let scanStartedAt: Date;
  if (importRow.stats?.scanAfter) {
    scanAfter = new Date(importRow.stats.scanAfter);
    scanIsFull = importRow.stats.scanIsFull === true;
    scanStartedAt = importRow.stats.scanStartedAt
      ? new Date(importRow.stats.scanStartedAt)
      : new Date();
  } else {
    const window = await resolveScanWindow(userId, {
      full: importRow.stats?.scanIsFull === true,
    });
    scanAfter = window.after;
    scanIsFull = window.isFull;
    scanStartedAt = new Date();
    await patchStats(importId, {
      scanAfter: scanAfter.toISOString(),
      scanIsFull,
      scanStartedAt: scanStartedAt.toISOString(),
    });
  }

  try {
    if (!importRow.stats?.discoveryComplete) {
      const finished = await runDiscovery(
        importId,
        userId,
        accessToken,
        jobStart,
        scanAfter,
        deps,
      );
      if (!finished) return;
    }

    let processed = importRow.rowsProcessed ?? 0;
    let consecutiveFailures = 0;

    while (true) {
      if (Date.now() - jobStart > TIME_BUDGET_MS) {
        await deps.continueLater(importId);
        return;
      }

      // Re-read so a cancel from the UI takes effect mid-run.
      const current = await db.query.imports.findFirst({
        where: eq(imports.id, importId),
      });
      if (!current || current.status !== "processing") return;

      const pending = await db.query.importJobRows.findMany({
        where: and(
          eq(importJobRows.importId, importId),
          eq(importJobRows.status, "pending"),
        ),
        orderBy: [asc(importJobRows.rowIndex)],
        limit: SCAN_BATCH_SIZE,
      });
      if (pending.length === 0) break;

      let found = current.stats?.recruitersFound ?? 0;
      let rejected = current.stats?.sendersRejected ?? 0;

      // Classification is the whole cost of a scan, and nobody is reading the results as
      // they land — so the senders go to the provider's Batch API at half price, and the
      // job waits for them. Whatever the batch will not take is classified inline below,
      // one sender at a time, exactly as before.
      const queued = new Set<string>();
      const batchable: Array<{
        row: (typeof pending)[number];
        payload: GmailSenderRowPayload;
        messages: GmailMessageContent[];
      }> = [];
      for (const row of pending) {
        if (!isGmailSenderRow(row.payload)) continue;
        const messages = await deps.fetchMessages(
          accessToken,
          row.payload.messageIds.slice(0, 5),
        );
        if (messages.length === 0) continue; // the inline pass below records it as rejected
        batchable.push({ row, payload: row.payload, messages });
      }
      if (batchable.length > 0) {
        const items = batchable.map((b, i) => ({
          customId: `s${i}`,
          rowId: b.row.id,
          payload: b.payload,
          meta: mailMetaOf(b.payload, b.messages),
        }));
        const jobId = await deps.submit(
          userId,
          "recruiter.scan",
          batchable.map((b, i) => ({
            customId: `s${i}`,
            system: RECRUITER_SYSTEM,
            user: buildRecruiterUserPrompt({
              senderName: b.payload.name,
              senderEmail: b.payload.email,
              firmGuess: b.payload.firm,
              messages: b.messages,
            }),
            temperature: 0.2,
            maxOutputTokens: 700,
          })),
          { importId, items } satisfies RecruiterBatchPayload,
        );
        if (jobId) {
          for (const b of batchable) queued.add(b.row.id);
          await db
            .update(importJobRows)
            .set({ status: SCAN_ROW_QUEUED, updatedAt: new Date() })
            .where(
              inArray(
                importJobRows.id,
                batchable.map((b) => b.row.id),
              ),
            );
        }
      }

      // Whatever the batch did not take is classified here, one sender per model call —
      // and only CHUNK_SIZE of them per iteration, because each one is a round trip and
      // the time budget is only checked at the top of the loop.
      let inlineProcessed = 0;
      for (const row of pending) {
        if (queued.has(row.id)) continue;
        if (inlineProcessed >= CHUNK_SIZE) break;
        inlineProcessed += 1;
        if (!isGmailSenderRow(row.payload)) {
          await db
            .update(importJobRows)
            .set({ status: "skipped", updatedAt: new Date() })
            .where(eq(importJobRows.id, row.id));
          continue;
        }

        try {
          const outcome = await processSender(
            userId,
            row.payload,
            accessToken,
            deps,
          );
          consecutiveFailures = 0;
          if (outcome === "recruiter") found += 1;
          else rejected += 1;
          await db
            .update(importJobRows)
            .set({
              status: outcome === "recruiter" ? "done" : "skipped",
              updatedAt: new Date(),
            })
            .where(eq(importJobRows.id, row.id));
        } catch (err) {
          // The key, not the sender: stop now, row left pending, watermark untouched.
          const keyProblem = scanAbortReason(err);
          if (keyProblem) {
            await failImport(importId, new Error(keyProblem));
            return;
          }
          // A dead sender must not kill the scan — record why and move on.
          const message =
            err instanceof Error ? err.message : "Couldn’t read this sender";
          rejected += 1;
          consecutiveFailures += 1;
          await db
            .update(importJobRows)
            .set({
              status: "skipped",
              errorMessage: truncateStoredError(message),
              updatedAt: new Date(),
            })
            .where(eq(importJobRows.id, row.id));
          // Unless they keep dying: a streak means the scan as a whole is broken, and
          // "completing" would advance the watermark past everything it skipped.
          if (consecutiveFailures >= MAX_CONSECUTIVE_SENDER_FAILURES) {
            await failImport(
              importId,
              new Error(SCAN_CONSECUTIVE_FAILURES_COPY),
            );
            return;
          }
        }
        processed += 1;
      }

      await db
        .update(imports)
        .set({
          rowsProcessed: processed,
          contactsCreated: found,
          stats: {
            ...(current.stats || {}),
            recruitersFound: found,
            sendersRejected: rejected,
          },
          updatedAt: new Date(),
        })
        .where(eq(imports.id, importId));
    }

    // Senders still out with a provider are not done, and completing would advance the
    // watermark past mail nothing has read yet. The batch sweep finishes the job instead,
    // once their answers land.
    await finalizeRecruiterScanIfDone(importId);
  } catch (err) {
    await failImport(importId, err);
  }
}

/**
 * Writes one batched verdict back: the same row states, counters and recruiter writes the
 * inline pass makes. An answer that is not the shape it promised marks the sender skipped
 * with the reason, exactly as a failed inline classification does.
 */
export async function applyRecruiterScanOutcome(
  userId: string,
  item: RecruiterBatchPayload["items"][number],
  content: string | null,
): Promise<"recruiter" | "rejected"> {
  const db = await getDb();
  let outcome: "recruiter" | "rejected" = "rejected";
  let errorMessage: string | null = null;
  try {
    if (!content)
      throw new Error("The classifier returned nothing for this sender");
    outcome = await applyRecruiterVerdict(
      userId,
      item.payload,
      item.meta,
      recruiterResultFromContent(content),
    );
  } catch (err) {
    errorMessage = truncateStoredError(
      err instanceof Error ? err.message : "Couldn’t read this sender",
    );
  }

  await db
    .update(importJobRows)
    .set({
      status: outcome === "recruiter" ? "done" : "skipped",
      errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(importJobRows.id, item.rowId));

  const row = await db.query.importJobRows.findFirst({
    where: eq(importJobRows.id, item.rowId),
    columns: { importId: true },
  });
  if (row) {
    const current = await db.query.imports.findFirst({
      where: eq(imports.id, row.importId),
    });
    if (current) {
      const found =
        (current.stats?.recruitersFound ?? 0) +
        (outcome === "recruiter" ? 1 : 0);
      const rejected =
        (current.stats?.sendersRejected ?? 0) +
        (outcome === "recruiter" ? 0 : 1);
      await db
        .update(imports)
        .set({
          rowsProcessed: (current.rowsProcessed ?? 0) + 1,
          contactsCreated: found,
          stats: {
            ...(current.stats || {}),
            recruitersFound: found,
            sendersRejected: rejected,
          },
          updatedAt: new Date(),
        })
        .where(eq(imports.id, row.importId));
    }
  }
  return outcome;
}

/**
 * Takes senders out of the queued state: back to `pending` when their batch will never
 * answer (the scan's own resume path classifies them one at a time), or `skipped` when the
 * scan they belong to is over and their answers are no longer wanted.
 */
export async function releaseRecruiterScanRows(
  rowIds: string[],
  to: "pending" | "skipped" = "pending",
): Promise<void> {
  if (rowIds.length === 0) return;
  const db = await getDb();
  await db
    .update(importJobRows)
    .set({ status: to, updatedAt: new Date() })
    .where(
      and(
        inArray(importJobRows.id, rowIds),
        eq(importJobRows.status, SCAN_ROW_QUEUED),
      ),
    );
}

/** Whether a scan is still open to results — false once it completed, failed or was cancelled. */
export async function recruiterScanIsRunning(
  importId: string,
): Promise<boolean> {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: eq(imports.id, importId),
    columns: { status: true },
  });
  return row?.status === "processing";
}

/** Keeps a scan that is waiting on a batch from looking stalled to the resume sweep. */
export async function touchImport(importId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(imports)
    .set({ updatedAt: new Date() })
    .where(eq(imports.id, importId));
}
