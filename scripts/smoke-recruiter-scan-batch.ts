/**
 * The Gmail recruiter scan through a provider's Batch API: senders go out together at half
 * price, the job waits for them rather than completing (which would advance the mailbox
 * watermark past mail nothing has read), and a batch that will never answer hands its
 * senders back to the ordinary one-at-a-time path.
 *
 * Local PGlite, stubbed provider. Run: npx tsx scripts/smoke-recruiter-scan-batch.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { imports, importJobRows, recruiterScanState, userRecruiterLinks, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import type { GmailMessageContent } from "../src/lib/gmail";
import {
  SCAN_ROW_QUEUED,
  runGmailRecruiterScanJob,
  type ScanDeps,
} from "../src/lib/gmail-scan-processor";
import { runAiBatchSweep } from "../src/lib/ai-batch-apply";
import { submitAiBatch } from "../src/lib/ai-batch";
import { aiBatchJobs } from "../src/db/schema";

const USER = "smoke-scan-batch-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

let batchDone = false;
let batchFails = false;
let batchSeq = 0;
const VERDICT = JSON.stringify({
  is_recruiter: true,
  confidence: 0.92,
  full_name: "Dana Holt",
  firm: "TalentBridge",
  companies_mentioned: ["Larkspur Robotics"],
  roles_discussed: ["Senior Backend Engineer"],
  summary: "Dana approached you about a backend role at Larkspur.",
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (/:batchGenerateContent/.test(url)) {
    return Response.json({ name: `batches/scan-${++batchSeq}`, metadata: { state: "BATCH_STATE_PENDING" } });
  }
  if (/\/v1beta\/batches\//.test(url)) {
    if (method === "DELETE") return Response.json({});
    return Response.json({
      name: url.split("/").pop() ?? "batches/scan",
      metadata: {
        state: batchFails ? "BATCH_STATE_FAILED" : batchDone ? "BATCH_STATE_SUCCEEDED" : "BATCH_STATE_RUNNING",
        ...(batchDone && !batchFails
          ? {
              output: {
                inlinedResponses: {
                  inlinedResponses: [0, 1, 2].map(() => ({
                    response: {
                      candidates: [{ content: { parts: [{ text: VERDICT }] } }],
                      usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 50 },
                    },
                  })),
                },
              },
            }
          : {}),
      },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

const message = (id: string): GmailMessageContent => ({
  id, threadId: `t-${id}`, from: "Dana Holt <dana@talentbridge.example>", to: "me@example.com",
  subject: "Senior Backend Engineer at Larkspur", snippet: "open role", internalDate: Date.parse("2026-08-01"),
  listUnsubscribe: "", listId: "", precedence: "", body: "I'm recruiting for a Senior Backend Engineer role at Larkspur Robotics.",
});

const deps: ScanDeps = {
  getAccessToken: async () => "stub-token",
  listPage: async () => { throw new Error("discovery must not run"); },
  fetchHeaders: async () => { throw new Error("discovery must not run"); },
  fetchMessages: async (_token, ids) => ids.map(message),
  classify: async () => { throw new Error("the inline classifier must not be used when a batch took the senders"); },
  submit: submitAiBatch,
  continueLater: async () => {},
};

async function seedJob(senders: number): Promise<string> {
  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, USER));
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({
    userId: USER, aiProvider: "gemini", aiModel: "gemini-3.5-flash", geminiApiKeyEncrypted: encrypt("fake-key"),
  });
  const [job] = await db.insert(imports).values({
    userId: USER,
    importType: "gmail_recruiter_scan",
    status: "processing",
    totalRows: senders,
    stats: {
      discoveryComplete: true,
      scanAfter: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      scanIsFull: false,
      scanStartedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  }).returning();
  await db.insert(importJobRows).values(
    Array.from({ length: senders }, (_, i) => ({
      importId: job.id, userId: USER, rowIndex: i, status: "pending",
      payload: { kind: "gmail_sender" as const, email: `s${i}@talentbridge.example`, name: `Sender ${i}`, firm: "TalentBridge", messageIds: [`m${i}`] },
    }))
  );
  return job.id;
}

const state = async (importId: string) => {
  const db = await getDb();
  const job = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, importId) });
  const mark = await db.query.recruiterScanState.findFirst({ where: eq(recruiterScanState.userId, USER) });
  return { status: job?.status, stats: job?.stats, rows: rows.map((r) => r.status), watermark: mark?.lastScanAt ?? null };
};

async function main() {
  const db = await getDb();

  console.log("Senders go out as one batch, and the scan waits for them");
  batchDone = false;
  batchFails = false;
  const importId = await seedJob(3);
  await runGmailRecruiterScanJob(importId, deps);
  const queued = await state(importId);
  check("every sender is queued, none classified inline", queued.rows.every((s) => s === SCAN_ROW_QUEUED), queued.rows.join(","));
  check("the scan stays open while they are out", queued.status === "processing", String(queued.status));
  check("and the mailbox watermark has not moved", queued.watermark === null);

  const before = (await db.query.imports.findFirst({ where: eq(imports.id, importId) }))!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const waiting = await runAiBatchSweep();
  check("an unfinished batch leaves the job pending", waiting.pending === 1, JSON.stringify(waiting));
  const after = (await db.query.imports.findFirst({ where: eq(imports.id, importId) }))!.updatedAt;
  check("  and keeps the scan from looking stalled", after.getTime() > before.getTime());

  batchDone = true;
  const swept = await runAiBatchSweep();
  check("the finished batch is applied", swept.applied === 1, JSON.stringify(swept));
  const done = await state(importId);
  check("every sender is settled", done.rows.every((s) => s === "done" || s === "skipped"), done.rows.join(","));
  // All three senders are the same person in this fixture, so the canonical recruiter
  // dedupes them into one link — the batched path writes exactly what the inline one does.
  const links = await db.query.userRecruiterLinks.findMany({ where: eq(userRecruiterLinks.userId, USER) });
  check("the recruiter is linked to the user", links.length === 1, String(links.length));
  check("  with the summary and roles from the batch", Boolean(links[0]?.aiSummary?.includes("Larkspur")) && (links[0]?.rolesDiscussed ?? []).length > 0);
  check("the scan completes", done.status === "completed", String(done.status));
  check("  its counters match", done.stats?.recruitersFound === 3 && done.rows.length === 3, JSON.stringify(done.stats));
  check("  and only now does the watermark move", done.watermark !== null);

  console.log("\nA batch that will never answer hands the senders back");
  batchDone = false;
  batchFails = false;
  const secondId = await seedJob(3);
  await runGmailRecruiterScanJob(secondId, deps);
  batchFails = true;
  batchDone = true;
  const failedSweep = await runAiBatchSweep();
  batchFails = false;
  check("the batch is counted as failed", failedSweep.failed === 1, JSON.stringify(failedSweep));
  const released = await state(secondId);
  check("the senders are pending again, for the one-at-a-time path", released.rows.every((s) => s === "pending"), released.rows.join(","));
  check("the scan is still open", released.status === "processing", String(released.status));
  check("and the watermark still has not moved", released.watermark === null);

  console.log("\nAnswers for a scan that is over are dropped");
  {
    batchDone = false;
    batchFails = false;
    const thirdId = await seedJob(3);
    await runGmailRecruiterScanJob(thirdId, deps);
    // The person cancels while the senders are still out.
    await db.update(imports).set({ status: "cancelled" }).where(eq(imports.id, thirdId));
    const linksBefore = (await db.query.userRecruiterLinks.findMany({ where: eq(userRecruiterLinks.userId, USER) })).length;
    batchDone = true;
    await runAiBatchSweep();
    const after = await state(thirdId);
    check("the cancelled scan gains no recruiters", (await db.query.userRecruiterLinks.findMany({ where: eq(userRecruiterLinks.userId, USER) })).length === linksBefore);
    check("  and its senders are left settled, not queued", after.rows.every((r) => r === "skipped"), after.rows.join(","));
    check("  while the scan stays cancelled", after.status === "cancelled", String(after.status));
  }

  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, USER));
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll batched recruiter-scan checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
