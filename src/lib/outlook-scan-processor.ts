import { and, asc, eq } from "drizzle-orm";
import { classifyAiError, friendlyError, ReauthRequiredError } from "@/lib/errors";
import { getDb } from "@/db";
import {
  outlookConnections,
  imports,
  importJobRows,
  userRecruiterLinks,
  isOutlookSenderRow,
  type OutlookSenderRowPayload,
  type ImportStats,
} from "@/db/schema";
import { internalFetch } from "@/lib/internal-auth";
import { failImport } from "@/lib/import-job-processor";
import {
  buildOutlookRecruiterQuery,
  fetchOutlookExcludedFolderIds,
  fetchOutlookMessageHeaders,
  fetchOutlookMessages,
  getValidAccessToken,
  listOutlookMessagePage,
} from "@/lib/outlook";
import { OUTLOOK_SCAN_IMPORT_TYPE } from "@/lib/outlook-scan-type";
import { firmFromEmail, looksLikeRecruiter, parseFromHeader } from "@/lib/recruiter-detect";
import {
  RECRUITER_CONFIDENCE_FLOOR,
  classifyRecruiterSender,
} from "@/lib/recruiter-scan";
import { lastCompletedScanStart, resolveScanWindow } from "@/lib/recruiter-scan-state";
import { classifySenderKind } from "@/lib/recruiter-triage";
import {
  MAX_CONSECUTIVE_SENDER_FAILURES,
  SCAN_CONSECUTIVE_FAILURES_COPY,
  SCAN_KEY_PROBLEM_COPY,
} from "@/lib/gmail-scan-processor";
import { ensureUserLink, isViewerSharing, upsertCanonicalRecruiter } from "@/lib/recruiters";
import { reportError } from "@/lib/report-error";

export { OUTLOOK_SCAN_IMPORT_TYPE } from "@/lib/outlook-scan-type";

/**
 * Small on purpose — mirrors `gmail-scan-processor.ts`'s reasoning exactly. Each row is a
 * handful of Graph message fetches plus one LLM call, so a larger chunk would blow the
 * time budget in a single pass.
 */
const CHUNK_SIZE = 8;
/** Same headroom as the Gmail runner: stay under the 300s ceiling with room to hand off. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;
const DISCOVERY_PAGE_SIZE = 200;
/** Ids kept per sender. The classifier reads the most recent few; the rest are for counts. */
const MAX_IDS_PER_SENDER = 12;
/**
 * Ceiling on candidate senders per scan — same reasoning as Gmail's. A mailbox with
 * thousands of recruiter-ish senders would otherwise bill the user's own API key for
 * thousands of LLM calls. Reaching it is reported in the UI, never silently truncated.
 */
const MAX_CANDIDATE_SENDERS = 400;

/**
 * Failure kinds that mean the KEY is the problem, not the sender — see the Gmail runner. The
 * copy and the failure-streak limit are shared with it (imported, not restated) so the two
 * scans cannot drift into telling a person different things about the same dead key.
 */
function scanAbortReason(err: unknown): string | null {
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    // Provider copy that is already Orbit's own words passes through; raw text does not.
    return friendlyError(err, SCAN_KEY_PROBLEM_COPY[kind]);
  }
  return null;
}

/** Graph, the classifier and the continuation kick — injectable so the loop is testable. */
export type OutlookScanDeps = {
  getAccessToken: (userId: string, opts?: { minValidityMs?: number }) => Promise<string>;
  listPage: typeof listOutlookMessagePage;
  excludedFolders: typeof fetchOutlookExcludedFolderIds;
  fetchHeaders: typeof fetchOutlookMessageHeaders;
  fetchMessages: typeof fetchOutlookMessages;
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
    reportError(err, { where: "job.outlook-scan.continuation-kick", level: "warning", extra: { importId } });
  }
}

const DEFAULT_SCAN_DEPS: OutlookScanDeps = {
  getAccessToken: getValidAccessToken,
  listPage: listOutlookMessagePage,
  excludedFolders: fetchOutlookExcludedFolderIds,
  fetchHeaders: fetchOutlookMessageHeaders,
  fetchMessages: fetchOutlookMessages,
  classify: classifyRecruiterSender,
  continueLater: scheduleContinuation,
};

/**
 * Phase A: walk the mailbox and turn recruiter-ish senders into work rows.
 *
 * Resumable at page granularity, same as Gmail's discovery — grouping happens against rows
 * already in the DB rather than an in-memory map, because a continuation starts with an
 * empty heap and would otherwise create a second row for a sender it had already seen.
 *
 * The one structural difference from Gmail: Graph hands back a full `@odata.nextLink` URL
 * rather than a bare page token, so the persisted cursor (`outlookNextLink`) is that whole
 * URL, refetched directly via `opts.skipToken` on resume.
 *
 * Returns false when it ran out of time and has scheduled its own continuation.
 */
async function runDiscovery(
  importId: string,
  userId: string,
  accessToken: string,
  jobStart: number,
  scanAfter: Date,
  deps: OutlookScanDeps
): Promise<boolean> {
  const db = await getDb();

  const existing = await db.query.importJobRows.findMany({
    where: eq(importJobRows.importId, importId),
  });
  const byEmail = new Map<string, { id: string; payload: OutlookSenderRowPayload }>();
  for (const row of existing) {
    if (isOutlookSenderRow(row.payload)) {
      byEmail.set(row.payload.email, { id: row.id, payload: row.payload });
    }
  }

  const startRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  let nextLink = startRow?.stats?.outlookNextLink ?? null;
  let scanned = startRow?.stats?.messagesScanned ?? 0;

  // Graph cannot exclude a folder inside `$search`, so Junk and Deleted Items are dropped
  // here once each message's folder is known — the stand-in for Gmail's `-in:spam -in:trash`.
  const excludedFolders = await deps.excludedFolders(accessToken);
  const scanAfterMs = scanAfter.getTime();

  while (true) {
    if (Date.now() - jobStart > TIME_BUDGET_MS) {
      await patchStats(importId, {
        outlookNextLink: nextLink,
        messagesScanned: scanned,
        candidateSenders: byEmail.size,
      });
      await deps.continueLater(importId);
      return false;
    }

    const page = await deps.listPage(accessToken, {
      // Bounded by the resolved window, in the query itself, so out-of-window mail is never
      // fetched. The client-side check below is the backstop.
      query: buildOutlookRecruiterQuery({ after: scanAfter }),
      skipToken: nextLink,
      top: DISCOVERY_PAGE_SIZE,
    });

    if (page.messages.length > 0) {
      const headers = await deps.fetchHeaders(accessToken, page.messages);
      scanned += page.messages.length;

      for (const msg of headers) {
        if (msg.internalDate != null && msg.internalDate < scanAfterMs) continue;
        if (msg.folderId && excludedFolders.has(msg.folderId)) continue;
        // Outlook's answer to Gmail's `-category:promotions -category:social -from:<job
        // boards>`: newsletters and job-board mail are cut here, by `List-Unsubscribe` /
        // `List-Id` / `Precedence` and the job-board domain list, before they cost a
        // classification. ATS mail is deliberately NOT cut (see `classifySenderKind`).
        if (classifySenderKind(msg) === "bulk") continue;
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

        const payload: OutlookSenderRowPayload = {
          kind: "outlook_sender",
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

    nextLink = page.nextLink;
    await patchStats(importId, {
      outlookNextLink: nextLink,
      messagesScanned: scanned,
      candidateSenders: byEmail.size,
    });

    if (!nextLink) break;
  }

  await db
    .update(imports)
    .set({ totalRows: byEmail.size, updatedAt: new Date() })
    .where(eq(imports.id, importId));
  await patchStats(importId, {
    discoveryComplete: true,
    outlookNextLink: null,
    messagesScanned: scanned,
    candidateSenders: byEmail.size,
  });
  return true;
}

/** Phase B: classify and summarize one sender, writing through to the recruiter tables. */
async function processSender(
  userId: string,
  payload: OutlookSenderRowPayload,
  accessToken: string,
  deps: OutlookScanDeps
): Promise<"recruiter" | "rejected"> {
  const messages = await deps.fetchMessages(accessToken, payload.messageIds.slice(0, 5));
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

  // The sender's address came from THIS user's mailbox; it lands on a shared row only when
  // this user shares. Identical to the Gmail scan — the two must never differ on privacy.
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
    source: "outlook",
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
 * Processes an Outlook recruiter scan in time-boxed chunks.
 *
 * Safe to call repeatedly — self-continuation, the stalled-job cron, and a manual retry
 * all land here, and it re-reads job and row state from the DB every iteration rather
 * than assuming it is starting fresh. Mirrors `runGmailRecruiterScanJob`.
 */
export async function runOutlookRecruiterScanJob(
  importId: string,
  deps: OutlookScanDeps = DEFAULT_SCAN_DEPS
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
    accessToken = await deps.getAccessToken(userId, { minValidityMs: TIME_BUDGET_MS + 60_000 });
  } catch (err) {
    await failImport(importId, err);
    return;
  }

  // Resolve the window once, on the first invocation, and freeze it into the job. Later
  // invocations read it back rather than re-deriving it, so every page of a multi-invocation
  // scan is drawn from the same slice of the mailbox.
  //
  // The watermark is THIS mailbox's own — the start of the newest completed Outlook scan —
  // not the shared `recruiter_scan_state` row the Gmail scan uses. That row holds one
  // watermark per user, so sharing it would make a user's first Outlook scan incremental
  // (skipping their whole history) the moment a Gmail scan had completed, and would push
  // Gmail's watermark past mail Gmail never read. Completion needs no separate write: a
  // job reaching `completed` with `stats.scanStartedAt` frozen IS the watermark.
  let scanAfter: Date;
  if (importRow.stats?.scanAfter) {
    scanAfter = new Date(importRow.stats.scanAfter);
  } else {
    const window = await resolveScanWindow(userId, {
      full: importRow.stats?.scanIsFull === true,
      since: await lastCompletedScanStart(userId, OUTLOOK_SCAN_IMPORT_TYPE),
    });
    scanAfter = window.after;
    await patchStats(importId, {
      scanAfter: scanAfter.toISOString(),
      scanIsFull: window.isFull,
      scanStartedAt: new Date().toISOString(),
    });
  }

  try {
    if (!importRow.stats?.discoveryComplete) {
      const finished = await runDiscovery(importId, userId, accessToken, jobStart, scanAfter, deps);
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
        if (!isOutlookSenderRow(row.payload)) {
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
          // The session, not the sender: every later fetch would fail the same way.
          if (err instanceof ReauthRequiredError) {
            await failImport(importId, err);
            return;
          }
          // The key, not the sender: stop now, row left pending.
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
          // "completing" would record a watermark over everything it skipped.
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

    // Only a job that reaches `completed` becomes the next scan's watermark (see the window
    // resolution above). A failed or cancelled scan leaves it where it was, so the next run
    // re-reads the window it never finished rather than stepping over unread mail.
    await db
      .update(imports)
      .set({ status: "completed", rowsProcessed: processed, updatedAt: new Date() })
      .where(eq(imports.id, importId));

    // Feeds the "last synced" line in the connection status.
    await db
      .update(outlookConnections)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(outlookConnections.userId, userId));
  } catch (err) {
    await failImport(importId, err);
  }
}
