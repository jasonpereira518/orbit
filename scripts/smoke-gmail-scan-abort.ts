/**
 * The recruiter scan must stop — without advancing its watermark — when the AI key is the
 * problem, or when senders keep failing in a row. Otherwise a dead key "completes" the scan
 * and the unread window is skipped forever. Gmail and the classifier are injected.
 *
 * Run: npx tsx scripts/smoke-gmail-scan-abort.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { importJobRows, imports, recruiterScanState } from "../src/db/schema";
import { aiProviderErrorMessage } from "../src/lib/errors";
import type { GmailMessageContent } from "../src/lib/gmail";
import {
  MAX_CONSECUTIVE_SENDER_FAILURES,
  SCAN_CONSECUTIVE_FAILURES_COPY,
  SCAN_KEY_PROBLEM_COPY,
  runGmailRecruiterScanJob,
  type ScanDeps,
} from "../src/lib/gmail-scan-processor";

/** A stored failure message is the copy, optionally followed by Phase 0's "(ref …)". */
function isCopy(actual: string | null | undefined, expected: string): boolean {
  return typeof actual === "string" && (actual === expected || actual.startsWith(`${expected} (ref `));
}

const USER = "smoke-scan-abort-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Classify = ScanDeps["classify"];
const notRecruiter: Awaited<ReturnType<Classify>> = {
  isRecruiter: false, confidence: 0.1, fullName: null, firm: null,
  companiesMentioned: [], rolesDiscussed: [], summary: null,
};

async function seedJob(senders: number): Promise<string> {
  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
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
      payload: { kind: "gmail_sender" as const, email: `s${i}@agency.test`, name: `Sender ${i}`, firm: "Agency", messageIds: [`m${i}`] },
    }))
  );
  return job.id;
}

function depsWith(classify: Classify) {
  let calls = 0;
  const message = (id: string): GmailMessageContent => ({
    id, threadId: `t-${id}`, from: "Sender <s@agency.test>", to: "me@example.com",
    subject: "Role at Acme", snippet: "open role", internalDate: Date.now(),
    listUnsubscribe: "", listId: "", precedence: "", body: "We are hiring.",
  });
  const deps: ScanDeps = {
    getAccessToken: async () => "stub-token",
    listPage: async () => { throw new Error("discovery must not run"); },
    fetchHeaders: async () => { throw new Error("discovery must not run"); },
    fetchMessages: async (_token, ids) => ids.map(message),
    classify: async (userId, input) => { calls++; return classify(userId, input); },
    continueLater: async () => {},
  };
  return { deps, calls: () => calls };
}

async function outcome(importId: string) {
  const db = await getDb();
  const job = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  const mark = await db.query.recruiterScanState.findFirst({ where: eq(recruiterScanState.userId, USER) });
  return { status: job?.status, error: job?.errorMessage ?? null, watermark: mark?.lastScanAt ?? null };
}

run(async () => {
  console.log("an out-of-credit key stops the scan at the first sender");
  {
    const id = await seedJob(6);
    const { deps, calls } = depsWith(async () => {
      throw new Error("429 You exceeded your current quota, please check your plan and billing details.");
    });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job ends failed", o.status === "failed", String(o.status));
    // Phase 0 appends "(ref …)" to a stored failure so a person can quote it.
    check("with the top-up copy", isCopy(o.error, SCAN_KEY_PROBLEM_COPY.quota), String(o.error));
    check("after one classifier call", calls() === 1, String(calls()));
    check("the watermark does not move", o.watermark === null, String(o.watermark));
  }

  console.log("already-rewritten provider copy passes through");
  {
    const id = await seedJob(3);
    const copy = aiProviderErrorMessage(new Error("401 Unauthorized: invalid x-api-key"), "Anthropic");
    const { deps } = depsWith(async () => { throw new Error(copy); });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job ends failed with the provider's own words", o.status === "failed" && isCopy(o.error, copy), String(o.error));
  }

  console.log(`${MAX_CONSECUTIVE_SENDER_FAILURES} failures in a row stop it too`);
  {
    const id = await seedJob(8);
    const { deps, calls } = depsWith(async () => { throw new Error("Unexpected token < in JSON"); });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job ends failed", o.status === "failed" && isCopy(o.error, SCAN_CONSECUTIVE_FAILURES_COPY), String(o.error));
    check(`after exactly ${MAX_CONSECUTIVE_SENDER_FAILURES} calls`, calls() === MAX_CONSECUTIVE_SENDER_FAILURES, String(calls()));
    check("the watermark does not move", o.watermark === null);
  }

  console.log("a success resets the streak");
  {
    const id = await seedJob(8);
    let n = 0;
    const { deps } = depsWith(async () => {
      n++;
      if (n <= MAX_CONSECUTIVE_SENDER_FAILURES - 1) throw new Error("Unexpected token < in JSON");
      return notRecruiter;
    });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job completes", o.status === "completed", `${o.status} ${o.error}`);
    check("and advances the watermark", o.watermark !== null);
  }

  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll scan-abort checks passed.");
});
