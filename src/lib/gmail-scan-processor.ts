import { and, asc, eq } from "drizzle-orm";
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
import { failImport } from "@/lib/import-job-processor";
import {
  buildRecruiterQuery,
  fetchGmailHeaders,
  fetchGmailMessages,
  firmFromEmail,
  getValidAccessToken,
  listGmailMessagePage,
  looksLikeRecruiter,
  parseFromHeader,
} from "@/lib/gmail";
import {
  RECRUITER_CONFIDENCE_FLOOR,
  classifyRecruiterSender,
} from "@/lib/recruiter-scan";
import { markScanCompleted, resolveScanWindow } from "@/lib/recruiter-scan-state";
import { ensureUserLink, isViewerSharing, upsertCanonicalRecruiter } from "@/lib/recruiters";
import { reportError } from "@/lib/report-error";

export { GMAIL_SCAN_IMPORT_TYPE } from "@/lib/gmail-scan-type";

/**
 * Small on purpose. Each row is a handful of Gmail body fetches plus one LLM call, so
 * the LinkedIn runner's chunk of 40 would blow the time budget in a single pass.
 */
const CHUNK_SIZE = 8;
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
  quota: "Your AI provider says your account is out of credit — top up with them, then scan again",
  model_unavailable: "Your AI model isn’t available — pick another in Settings, then scan again",
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
  getAccessToken: (userId: string, opts?: { minValidityMs?: number }) => Promise<string>;
  listPage: typeof listGmailMessagePage;
  fetchHeaders: typeof fetchGmailHeaders;
  fetchMessages: typeof fetchGmailMessages;
  classify: typeof classifyRecruiterSender;
  continueLater: (importId: string) => Promise<void>;
};

async function patchStats(importId: string, patch: Partial<ImportStats>) {
  const db = await getDb();
  const row = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!row) return;
  await db
    .update(imports)
    .set({ stats: { ...(row.stats || {}), ...patch }, updatedAt: new Date() })
    .where(eq(imports.id, importId));
}

/** Kick a fresh invocation so the remaining work continues past this function's ceiling. */
async function scheduleContinuation(importId: string) {
  try {
    await internalFetch(`/api/imports/${importId}/continue`, { method: "POST" });
  } catch (err) {
    // Best-effort — the process-stalled cron picks the job back up either way.
    reportError(err, { where: "job.gmail-scan.continuation-kick", level: "warning", extra: { importId } });
  }
}

const DEFAULT_SCAN_DEPS: ScanDeps = {
  getAccessToken: getValidAccessToken,
  listPage: listGmailMessagePage,
  fetchHeaders: fetchGmailHeaders,
  fetchMessages: fetchGmailMessages,
  classify: classifyRecruiterSender,
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
  deps: ScanDeps
): Promise<boolean> {
  const db = await getDb();

  const existing = await db.query.importJobRows.findMany({
    where: eq(importJobRows.importId, importId),
  });
  const byEmail = new Map<string, { id: string; payload: GmailSenderRowPayload }>();
  for (const row of existing) {
    if (isGmailSenderRow(row.payload)) {
      byEmail.set(row.payload.email, { id: row.id, payload: row.payload });
    }
  }

  const startRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
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
        if (!looksLikeRecruiter({
          from: msg.from,
          subject: msg.subject,
          snippet: msg.snippet,
        })) {
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
async function processSender(
  userId: string,
  payload: GmailSenderRowPayload,
  accessToken: string,
  deps: ScanDeps
): Promise<"recruiter" | "rejected"> {
  const messages = await deps.fetchMessages(
    accessToken,
    payload.messageIds.slice(0, 5)
  );
  if (messages.length === 0) return "rejected";

  const result = await deps.classify(userId, {
    senderName: payload.name,
    senderEmail: payload.email,
    firmGuess: payload.firm,
    messages,
  });

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
    { contributePii: await isViewerSharing(userId), createdByUserId: userId }
  );

  await ensureUserLink({
    userId,
    recruiterId: recruiter.id,
    status: "contacted",
    source: "gmail",
    // From THIS user's mailbox: it belongs on their own link whether or not they share.
    email: payload.email,
  });

  const dates = messages
    .map((m) => m.internalDate)
    .filter((d): d is number => typeof d === "number");
  const db = await getDb();
  await db
    .update(userRecruiterLinks)
    .set({
      aiSummary: result.summary,
      companiesMentioned: result.companiesMentioned,
      rolesDiscussed: result.rolesDiscussed,
      emailCount: payload.messageIds.length,
      firstEmailAt: dates.length ? new Date(Math.min(...dates)) : null,
      lastEmailAt: dates.length ? new Date(Math.max(...dates)) : null,
      gmailThreadId: messages[0]?.threadId || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userRecruiterLinks.userId, userId),
        eq(userRecruiterLinks.recruiterId, recruiter.id)
      )
    );

  return "recruiter";
}

/**
 * Processes a Gmail recruiter scan in time-boxed chunks.
 *
 * Safe to call repeatedly — self-continuation, the stalled-job cron, and a manual retry
 * all land here, and it re-reads job and row state from the DB every iteration rather
 * than assuming it is starting fresh.
 */
export async function runGmailRecruiterScanJob(importId: string, deps: ScanDeps = DEFAULT_SCAN_DEPS): Promise<void> {
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
    accessToken = await deps.getAccessToken(userId, { minValidityMs: TIME_BUDGET_MS + 60_000 });
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
        scanAfter
      ,
        deps
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
          eq(importJobRows.status, "pending")
        ),
        orderBy: [asc(importJobRows.rowIndex)],
        limit: CHUNK_SIZE,
      });
      if (pending.length === 0) break;

      let found = current.stats?.recruitersFound ?? 0;
      let rejected = current.stats?.sendersRejected ?? 0;

      for (const row of pending) {
        if (!isGmailSenderRow(row.payload)) {
          await db
            .update(importJobRows)
            .set({ status: "skipped", updatedAt: new Date() })
            .where(eq(importJobRows.id, row.id));
          continue;
        }

        try {
          const outcome = await processSender(userId, row.payload, accessToken, deps);
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
          const message = err instanceof Error ? err.message : "Classification failed";
          rejected += 1;
          consecutiveFailures += 1;
          await db
            .update(importJobRows)
            .set({
              status: "skipped",
              errorMessage: message.slice(0, 300),
              updatedAt: new Date(),
            })
            .where(eq(importJobRows.id, row.id));
          // Unless they keep dying: a streak means the scan as a whole is broken, and
          // "completing" would advance the watermark past everything it skipped.
          if (consecutiveFailures >= MAX_CONSECUTIVE_SENDER_FAILURES) {
            await failImport(importId, new Error(SCAN_CONSECUTIVE_FAILURES_COPY));
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

    await db
      .update(imports)
      .set({ status: "completed", rowsProcessed: processed, updatedAt: new Date() })
      .where(eq(imports.id, importId));

    // Only a job that reached `completed` may advance the watermark. A failed or cancelled
    // scan leaves it where it was, so the next run re-reads the window it never finished
    // rather than stepping over the messages it never got to.
    await markScanCompleted(userId, { startedAt: scanStartedAt, wasFull: scanIsFull });

    // Feeds the "last synced" line in the connection status.
    await db
      .update(gmailConnections)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(gmailConnections.userId, userId));
  } catch (err) {
    await failImport(importId, err);
  }
}
