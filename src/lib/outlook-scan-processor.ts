import { and, asc, eq } from "drizzle-orm";
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
  OUTLOOK_RECRUITER_SEARCH_QUERY,
  fetchOutlookMessageHeaders,
  getValidAccessToken,
  listOutlookMessagePage,
} from "@/lib/outlook";
import { firmFromEmail, looksLikeRecruiter, parseFromHeader } from "@/lib/recruiter-detect";
import {
  RECRUITER_CONFIDENCE_FLOOR,
  classifyRecruiterSender,
} from "@/lib/recruiter-scan";
import { ensureUserLink, upsertCanonicalRecruiter } from "@/lib/recruiters";

export const OUTLOOK_SCAN_IMPORT_TYPE = "outlook_recruiter_scan";

/**
 * Small on purpose — mirrors `gmail-scan-processor.ts`'s reasoning exactly. Each row is a
 * handful of Outlook header fetches plus one LLM call, so a larger chunk would blow the
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
  } catch {
    // Best-effort — the process-stalled cron picks the job back up either way.
  }
}

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
  jobStart: number
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

  while (true) {
    if (Date.now() - jobStart > TIME_BUDGET_MS) {
      await patchStats(importId, {
        outlookNextLink: nextLink,
        messagesScanned: scanned,
        candidateSenders: byEmail.size,
      });
      await scheduleContinuation(importId);
      return false;
    }

    const page = await listOutlookMessagePage(accessToken, {
      // No date filter — this is the whole mailbox, narrowed only by keywords.
      query: OUTLOOK_RECRUITER_SEARCH_QUERY,
      skipToken: nextLink,
      top: DISCOVERY_PAGE_SIZE,
    });

    if (page.messages.length > 0) {
      const headers = await fetchOutlookMessageHeaders(accessToken, page.messages);
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
  accessToken: string
): Promise<"recruiter" | "rejected"> {
  const refs = payload.messageIds.slice(0, 5).map((id) => ({ id }));
  const headers = await fetchOutlookMessageHeaders(accessToken, refs);
  if (headers.length === 0) return "rejected";

  // `classifyRecruiterSender` is typed against Gmail's `GmailMessageContent`, but only
  // reads `subject`/`body`/`snippet`/`internalDate` — every one of those fields is present
  // here too, so the shape is reused structurally rather than duplicating the classifier
  // for a second provider. `body` is Graph's `bodyPreview`: there is no cheaper full-body
  // fetch on this path, mirroring the same "keep it cheap" choice the calendar connector
  // makes for event descriptions.
  const messages = headers.map((h) => ({
    id: h.id,
    threadId: "",
    from: h.from,
    subject: h.subject,
    snippet: h.snippet,
    internalDate: h.internalDate,
    body: h.snippet,
  }));

  const result = await classifyRecruiterSender(userId, {
    senderName: payload.name,
    senderEmail: payload.email,
    firmGuess: payload.firm,
    messages,
  });

  if (!result.isRecruiter || result.confidence < RECRUITER_CONFIDENCE_FLOOR) {
    return "rejected";
  }

  const recruiter = await upsertCanonicalRecruiter({
    fullName: result.fullName || payload.name,
    firm: result.firm || payload.firm,
    email: payload.email,
    specialty: result.rolesDiscussed,
  });

  await ensureUserLink({
    userId,
    recruiterId: recruiter.id,
    status: "contacted",
    source: "outlook",
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
 * than assuming it is starting fresh. Mirrors `runGmailRecruiterScanJob` exactly.
 */
export async function runOutlookRecruiterScanJob(importId: string): Promise<void> {
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
    accessToken = await getValidAccessToken(userId);
  } catch (err) {
    await failImport(importId, err);
    return;
  }

  try {
    if (!importRow.stats?.discoveryComplete) {
      const finished = await runDiscovery(importId, userId, accessToken, jobStart);
      if (!finished) return;
    }

    let processed = importRow.rowsProcessed ?? 0;

    while (true) {
      if (Date.now() - jobStart > TIME_BUDGET_MS) {
        await scheduleContinuation(importId);
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
          const outcome = await processSender(userId, row.payload, accessToken);
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
          // A dead sender must not kill the scan — record why and move on.
          const message = err instanceof Error ? err.message : "Classification failed";
          rejected += 1;
          await db
            .update(importJobRows)
            .set({
              status: "skipped",
              errorMessage: message.slice(0, 300),
              updatedAt: new Date(),
            })
            .where(eq(importJobRows.id, row.id));
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

    // Feeds the "last synced" line in the connection status.
    await db
      .update(outlookConnections)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(outlookConnections.userId, userId));
  } catch (err) {
    await failImport(importId, err);
  }
}
