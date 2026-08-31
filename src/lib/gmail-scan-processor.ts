import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  gmailConnections,
  imports,
  importJobRows,
  isGmailThreadRow,
  recruiterOpportunities,
  type GmailThreadRowPayload,
  type ImportStats,
} from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { failImport } from "@/lib/import-job-processor";
import {
  buildRecruiterQuery,
  fetchGmailMessages,
  fetchGmailThreadsBatched,
  firmFromEmail,
  getValidAccessToken,
  listGmailMessagePage,
  parseFromHeader,
  type GmailThreadSummary,
} from "@/lib/gmail";
import {
  applyThreadFinding,
  loadVerdicts,
  recordFinding,
  recordVerdict,
  type ThreadFinding,
} from "@/lib/recruiter-opportunities";
import { markScanCompleted, resolveScanWindow } from "@/lib/recruiter-scan-state";
import { deriveAtsStage, triageThread } from "@/lib/recruiter-triage";
import {
  AUTO_APPLY_CONFIDENCE,
  RECRUITER_THREAD_CONFIDENCE_FLOOR,
  classifyThreads,
  type ThreadForClassification,
} from "@/lib/recruiter-thread-classify";

export const GMAIL_SCAN_IMPORT_TYPE = "gmail_recruiter_scan";

/**
 * Rows per pass. Each human row costs a body fetch, and every four of them cost one LLM call,
 * so this is sized to leave headroom inside the time budget rather than to maximize
 * throughput.
 */
const CHUNK_SIZE = 12;
/** Same headroom as the LinkedIn runner: stay under the 300s ceiling with room to hand off. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;
const DISCOVERY_PAGE_SIZE = 200;
/** Messages kept per thread. The classifier reads the most recent few. */
const MAX_IDS_PER_THREAD = 12;
/**
 * Ceiling on threads staged per scan. A mailbox with thousands of recruiter-ish threads would
 * otherwise bill the user's own API key for hundreds of calls in one run. Reaching it is
 * reported in the UI, never silently truncated.
 */
const MAX_THREADS = 600;

/** The two discovery arms, walked in order and checkpointed independently. */
const ARMS = ["inbound", "sent"] as const;
type Arm = (typeof ARMS)[number];

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
  const secret = process.env.CRON_SECRET;
  try {
    await fetch(`${getAppBaseUrl()}/api/imports/${importId}/continue`, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
    });
  } catch {
    // Best-effort — the process-stalled cron picks the job back up either way.
  }
}

function messageDate(ms: number | null | undefined): Date | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Turns a fetched thread into a work row, or decides it is not worth one.
 *
 * Returns null when triage rejects it. Note that *every* discovered thread gets a row either
 * way — accepted ones pending, dropped ones already `skipped` with their reason. Storing the
 * rejections is what makes the seen-set complete across invocations, so a resumed job neither
 * re-fetches a thread it already judged nor double-counts it.
 */
function buildThreadRow(
  thread: GmailThreadSummary,
  userEmail: string,
  arm: Arm,
  verdicts: Map<string, "recruiter" | "not_recruiter">
): { payload: GmailThreadRowPayload; accepted: boolean; reason: string } {
  const mine = userEmail.trim().toLowerCase();
  const isFromUser = (from: string) => Boolean(mine) && from.toLowerCase().includes(mine);

  const inbound = thread.messages.filter((m) => !isFromUser(m.from));
  const lead = thread.messages[0];
  // For a thread nobody answered, the correspondent is the recipient, not the sender.
  const contactHeader = inbound[0]?.from || lead?.to || "";
  const parsed = parseFromHeader(contactHeader);

  const cachedVerdict = parsed ? (verdicts.get(parsed.email) ?? null) : null;
  const outcome = triageThread({
    headers: thread.messages,
    userEmail,
    cachedVerdict,
  });

  const dates = thread.messages
    .map((m) => m.internalDate)
    .filter((d): d is number => typeof d === "number");

  const payload: GmailThreadRowPayload = {
    kind: "gmail_thread",
    threadId: thread.id,
    subject: lead?.subject || "",
    senderKind: outcome.kind === "ats" ? "ats" : "human",
    direction: arm === "sent" && inbound.length === 0 ? "outbound" : "inbound",
    email: parsed?.email || "",
    name: parsed?.name || "",
    firm: parsed ? firmFromEmail(parsed.email) : null,
    messageIds: thread.messages.slice(-MAX_IDS_PER_THREAD).map((m) => m.id),
    messageCount: thread.messages.length,
    userReplied: thread.messages.some((m) => isFromUser(m.from)),
    firstMessageAt: dates.length ? Math.min(...dates) : null,
    lastMessageAt: dates.length ? Math.max(...dates) : null,
    snippetText: thread.messages
      .map((m) => `${m.subject} ${m.snippet}`)
      .join("\n")
      .slice(0, 4000),
    triageReasons: outcome.reasons,
    triageScore: outcome.score,
  };

  const accepted = outcome.decision === "classify" || outcome.decision === "ats_rule";
  return { payload, accepted, reason: outcome.reasons.join(", ") || outcome.decision };
}

/**
 * Phase A + B: walk the mailbox, collapse hits to threads, and triage each one.
 *
 * Resumable at page granularity, per arm. Grouping happens against rows already in the DB
 * rather than an in-memory map, because a continuation starts with an empty heap and would
 * otherwise re-stage threads it had already seen.
 *
 * Returns false when it ran out of time and has scheduled its own continuation.
 */
async function runDiscovery(
  importId: string,
  userId: string,
  userEmail: string,
  accessToken: string,
  jobStart: number,
  scanAfter: Date
): Promise<boolean> {
  const db = await getDb();

  const existing = await db.query.importJobRows.findMany({
    where: eq(importJobRows.importId, importId),
  });
  const seen = new Set<string>();
  for (const row of existing) {
    if (isGmailThreadRow(row.payload)) seen.add(row.payload.threadId);
  }

  const verdicts = await loadVerdicts(userId);

  const startRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  let pageToken = startRow?.stats?.gmailPageToken ?? null;
  let scanned = startRow?.stats?.messagesScanned ?? 0;
  let armIndex = ARMS.indexOf((startRow?.stats?.scanArm as Arm) ?? "inbound");
  if (armIndex < 0) armIndex = 0;
  let rowIndex = existing.length;

  while (armIndex < ARMS.length) {
    const arm = ARMS[armIndex];

    if (Date.now() - jobStart > TIME_BUDGET_MS) {
      await patchStats(importId, {
        gmailPageToken: pageToken,
        scanArm: arm,
        messagesScanned: scanned,
        threadsDiscovered: seen.size,
      });
      await scheduleContinuation(importId);
      return false;
    }

    const page = await listGmailMessagePage(accessToken, {
      query: buildRecruiterQuery({ after: scanAfter, direction: arm }),
      pageToken,
      maxResults: DISCOVERY_PAGE_SIZE,
    });
    scanned += page.messages.length;

    // Collapse messages to threads before spending anything. Several hits in one conversation
    // are one unit of work, and this is where most of the volume disappears.
    const threadIds = [...new Set(page.messages.map((m) => m.threadId))].filter(
      (id) => !seen.has(id)
    );
    const room = Math.max(0, MAX_THREADS - seen.size);
    const toFetch = threadIds.slice(0, room);

    if (toFetch.length > 0) {
      const threads = await fetchGmailThreadsBatched(accessToken, toFetch);
      for (const thread of threads) {
        if (seen.has(thread.id)) continue;
        seen.add(thread.id);

        const { payload, accepted, reason } = buildThreadRow(
          thread,
          userEmail,
          arm,
          verdicts
        );
        await db.insert(importJobRows).values({
          importId,
          userId,
          rowIndex: rowIndex++,
          payload,
          status: accepted ? "pending" : "skipped",
          errorMessage: accepted ? null : reason.slice(0, 300),
        });
      }
    }

    pageToken = page.nextPageToken;
    if (!pageToken) {
      armIndex += 1;
      pageToken = null;
    }

    await patchStats(importId, {
      gmailPageToken: pageToken,
      scanArm: ARMS[Math.min(armIndex, ARMS.length - 1)],
      messagesScanned: scanned,
      threadsDiscovered: seen.size,
    });

    if (seen.size >= MAX_THREADS) break;
  }

  const counts = await countRows(importId);
  await db
    .update(imports)
    .set({ totalRows: counts.pending, updatedAt: new Date() })
    .where(eq(imports.id, importId));
  await patchStats(importId, {
    discoveryComplete: true,
    gmailPageToken: null,
    messagesScanned: scanned,
    threadsDiscovered: seen.size,
    triageAccepted: counts.pending,
    triageRejected: counts.skipped,
  });
  return true;
}

async function countRows(importId: string) {
  const db = await getDb();
  const rows = await db
    .select({ status: importJobRows.status, n: sql<number>`count(*)::int` })
    .from(importJobRows)
    .where(eq(importJobRows.importId, importId))
    .groupBy(importJobRows.status);
  const by = new Map(rows.map((r) => [r.status, r.n]));
  return {
    pending: by.get("pending") ?? 0,
    skipped: by.get("skipped") ?? 0,
    done: by.get("done") ?? 0,
  };
}

function findingFromPayload(
  payload: GmailThreadRowPayload,
  over: Partial<ThreadFinding>
): ThreadFinding {
  return {
    gmailThreadId: payload.threadId,
    subject: payload.subject,
    senderKind: payload.senderKind,
    direction: payload.direction,
    correspondentEmail: payload.email || null,
    correspondentName: payload.name || null,
    recruiterFirm: payload.firm,
    hiringCompany: null,
    roles: [],
    stage: "outreach_received",
    stageEvidence: null,
    summary: null,
    nextStep: null,
    confidence: 0,
    messageCount: payload.messageCount,
    userReplied: payload.userReplied,
    firstMessageAt: messageDate(payload.firstMessageAt),
    lastMessageAt: messageDate(payload.lastMessageAt),
    ...over,
  };
}

/**
 * Phase C for automated mail: read the stage off the templates, write nothing else.
 *
 * No network call and no tokens — the text was already carried on the row. ATS mail is the
 * highest-volume category in a job-seeker's inbox and, handled this way, the cheapest.
 */
function atsFinding(payload: GmailThreadRowPayload): ThreadFinding | null {
  const stage = deriveAtsStage(payload.snippetText);
  if (!stage) return null;

  // The company is the sending organisation, which the email domain names more reliably than
  // the boilerplate body does.
  const company = payload.firm;
  const evidence = payload.snippetText.slice(0, 200);

  return findingFromPayload(payload, {
    hiringCompany: company,
    stage,
    stageEvidence: evidence,
    // Deliberately not a contact: there is nobody behind an ATS address.
    correspondentEmail: null,
    correspondentName: null,
    // Rules are exact but shallow. High enough to apply without review, since a stage read
    // from a fixed template is more trustworthy than a model's guess about prose.
    confidence: 0.9,
  });
}

/** Phase C for human threads: fetch bodies, classify in batches, fold results back in. */
async function classifyHumanRows(
  userId: string,
  userEmail: string,
  accessToken: string,
  rows: Array<{ id: string; payload: GmailThreadRowPayload }>,
  onCall: () => void
): Promise<Map<string, ThreadFinding>> {
  const out = new Map<string, ThreadFinding>();
  if (rows.length === 0) return out;

  const inputs: ThreadForClassification[] = [];
  const byThread = new Map<string, GmailThreadRowPayload>();

  for (const row of rows) {
    const messages = await fetchGmailMessages(accessToken, row.payload.messageIds.slice(-6));
    if (messages.length === 0) continue;
    byThread.set(row.payload.threadId, row.payload);
    inputs.push({
      threadId: row.payload.threadId,
      subject: row.payload.subject,
      correspondentName: row.payload.name,
      correspondentEmail: row.payload.email,
      firmGuess: row.payload.firm,
      userEmail,
      messages,
    });
  }

  const results = await classifyThreads(userId, inputs, { onCall });

  for (const [threadId, result] of results) {
    const payload = byThread.get(threadId);
    if (!payload) continue;

    if (!result.isRecruiting || result.confidence < RECRUITER_THREAD_CONFIDENCE_FLOOR) {
      // Remember the rejection so this sender is never classified again at this prompt
      // version — the single biggest saving on a repeat scan.
      if (payload.email) {
        await recordVerdict(userId, payload.email, "not_recruiter", result.confidence);
      }
      continue;
    }

    out.set(
      threadId,
      findingFromPayload(payload, {
        direction: result.direction ?? payload.direction,
        correspondentName: result.recruiterName || payload.name || null,
        recruiterFirm: result.recruiterFirm || payload.firm,
        hiringCompany: result.hiringCompany,
        roles: result.roles,
        stage: result.stage ?? "in_conversation",
        stageEvidence: result.stageEvidence,
        summary: result.summary,
        nextStep: result.nextStep,
        confidence: result.confidence,
      })
    );
  }
  return out;
}

/**
 * Processes a Gmail recruiter scan in time-boxed chunks.
 *
 * Safe to call repeatedly — self-continuation, the stalled-job cron, and a manual retry all
 * land here, and it re-reads job and row state from the DB every iteration rather than
 * assuming it is starting fresh.
 */
export async function runGmailRecruiterScanJob(importId: string): Promise<void> {
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

  const connection = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });
  const userEmail = connection?.emailAddress ?? "";

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
        userEmail,
        accessToken,
        jobStart,
        scanAfter
      );
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

      const stats = current.stats || {};
      let atsHits = stats.atsRuleHits ?? 0;
      let llmCalls = stats.llmCalls ?? 0;
      let found = stats.recruitersFound ?? 0;
      let rejected = stats.sendersRejected ?? 0;
      let pendingFindings = stats.findingsPending ?? 0;

      const threadRows = pending.filter(
        (r): r is typeof r & { payload: GmailThreadRowPayload } =>
          isGmailThreadRow(r.payload)
      );

      // Anything else in the queue is a row from an older scan shape. Skip rather than guess.
      for (const row of pending) {
        if (!isGmailThreadRow(row.payload)) {
          await db
            .update(importJobRows)
            .set({ status: "skipped", updatedAt: new Date() })
            .where(eq(importJobRows.id, row.id));
        }
      }

      // Automated mail first: it needs no network and no model, so it finishes even if the
      // classification below runs out of budget.
      const findings = new Map<string, ThreadFinding>();
      for (const row of threadRows.filter((r) => r.payload.senderKind === "ats")) {
        const finding = atsFinding(row.payload);
        if (finding) {
          findings.set(row.payload.threadId, finding);
          atsHits += 1;
        }
      }

      const humanRows = threadRows.filter((r) => r.payload.senderKind === "human");
      try {
        const classified = await classifyHumanRows(
          userId,
          userEmail,
          accessToken,
          humanRows.map((r) => ({ id: r.id, payload: r.payload })),
          () => {
            llmCalls += 1;
          }
        );
        for (const [threadId, finding] of classified) findings.set(threadId, finding);
      } catch (err) {
        // A provider outage must not burn through the queue marking everything rejected.
        await failImport(importId, err, { llmCalls, atsRuleHits: atsHits });
        return;
      }

      for (const row of threadRows) {
        try {
          const finding = findings.get(row.payload.threadId);
          if (!finding) {
            rejected += 1;
            await db
              .update(importJobRows)
              .set({ status: "skipped", updatedAt: new Date() })
              .where(eq(importJobRows.id, row.id));
          } else {
            const autoApply =
              finding.confidence >= AUTO_APPLY_CONFIDENCE &&
              Boolean(finding.hiringCompany || finding.recruiterFirm);
            const status = await recordFinding(userId, importId, finding, { autoApply });
            if (status === "auto_applied") found += 1;
            else pendingFindings += 1;
            await db
              .update(importJobRows)
              .set({ status: "done", updatedAt: new Date() })
              .where(eq(importJobRows.id, row.id));
          }
        } catch (err) {
          // A dead thread must not kill the scan — record why and move on.
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
            ...stats,
            recruitersFound: found,
            sendersRejected: rejected,
            atsRuleHits: atsHits,
            llmCalls,
            findingsPending: pendingFindings,
          },
          updatedAt: new Date(),
        })
        .where(eq(imports.id, importId));
    }

    // Opportunities this scan actually touched — not a row count, and not the user's whole
    // pipeline. Anything written or merged during the run has an `updated_at` at or after the
    // job's start.
    const opportunities = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recruiterOpportunities)
      .where(
        and(
          eq(recruiterOpportunities.userId, userId),
          sql`${recruiterOpportunities.updatedAt} >= ${scanStartedAt}`
        )
      );

    await db
      .update(imports)
      .set({ status: "completed", rowsProcessed: processed, updatedAt: new Date() })
      .where(eq(imports.id, importId));
    await patchStats(importId, { opportunitiesFound: opportunities[0]?.n ?? 0 });

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

/** Re-runs the apply path for a finding a person approved in review. */
export async function applyApprovedFinding(
  userId: string,
  finding: ThreadFinding
): Promise<void> {
  await applyThreadFinding(userId, finding);
}
