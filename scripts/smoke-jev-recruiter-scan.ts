/**
 * The Gmail recruiter scan with a decision model (Jev) in the loop — the two places it acts:
 *
 *  - DISCOVERY: a sender the keyword prefilter drops, but Jev reads as a recruiter, becomes a
 *    candidate (a hiring manager with no recruiter words is the case the keywords miss).
 *  - CLASSIFICATION: a candidate Jev is confident is not a recruiter is settled as a
 *    rejection without ever being sent to the LLM, inline or in a batch.
 *
 * And the invariant: with no decider, the scan behaves exactly as it did before Jev.
 *
 * Local PGlite, a scripted decider, stubbed Gmail. Run: npx tsx scripts/smoke-jev-recruiter-scan.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiBatchJobs, imports, importJobRows, recruiterScanState, userRecruiterLinks, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import type { GmailHeaderSummary, GmailMessageContent } from "../src/lib/gmail";
import { runGmailRecruiterScanJob, type ScanDeps } from "../src/lib/gmail-scan-processor";
import { parseAnswers, type Decider, type DecisionRequest, type QuestionMap } from "../src/lib/decisions/jev";
import type { RecruiterScanResult } from "../src/lib/recruiter-scan";
import { run } from "./smoke/_env";

const USER = "smoke-jev-scan-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** P(recruiter) per sender address, for both the prefilter and the gate. */
const JEV: Record<string, number> = {
  "jo@agency.example": 0.97, // keyword match anyway
  "sam@startup.example": 0.9, // hiring manager, no recruiter words
  "news@digest.example": 0.03,
  "pat@vendor.example": 0.02, // a candidate by keywords, but plainly a vendor
};

function scriptedDecider(): Decider & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async ask(req: DecisionRequest<QuestionMap>) {
      asked.push(req.operation);
      const state = req.state as {
        sender?: { email: string };
        messages?: Record<string, { from: string }>;
      };
      let raw: Record<string, unknown>;
      if (req.operation === "recruiter.gate") {
        raw = { recruiter: { noul: JEV[state.sender!.email] ?? 0.5 } };
      } else {
        raw = Object.fromEntries(
          Object.entries(state.messages ?? {}).map(([k, m]) => [k, { noul: JEV[m.from.match(/<(.+)>/)![1]] ?? 0.5 }]),
        );
      }
      const answers = parseAnswers(req.questions, { answers: raw });
      return answers ? { answers, model: "jev-test" } : null;
    },
  } as Decider & { asked: string[] };
}

const header = (id: string, from: string, subject: string, snippet: string): GmailHeaderSummary => ({
  id, threadId: `t-${id}`, from, to: "me@example.com", subject, snippet,
  internalDate: Date.parse("2026-08-01"), listUnsubscribe: "", listId: "", precedence: "",
});

const INBOX = [
  header("m1", "Jo Park <jo@agency.example>", "Technical Recruiter — Staff role", "open role"),
  header("m2", "Sam Lee <sam@startup.example>", "Your background", "I lead platform at Startup and we have an opening on my team"),
  header("m3", "News <news@digest.example>", "This week", "top stories"),
  header("m4", "Pat Vendor <pat@vendor.example>", "Hiring for talent? Our staffing platform helps", "demo"),
];

const message = (id: string): GmailMessageContent => {
  const h = INBOX.find((x) => x.id === id)!;
  return { ...h, body: `${h.subject}. ${h.snippet}.` };
};

const VERDICT: RecruiterScanResult = {
  isRecruiter: true, confidence: 0.9, fullName: null, firm: null,
  companiesMentioned: [], rolesDiscussed: [], summary: "They reached out about a role.",
};

function depsWith(decider: Decider | null, classified: string[], submitted: string[]): ScanDeps {
  return {
    getAccessToken: async () => "stub-token",
    listPage: async () => ({ messages: INBOX.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: null }),
    fetchHeaders: async () => INBOX,
    fetchMessages: async (_token, ids) => ids.map(message),
    classify: async (_u, input) => {
      classified.push(input.senderEmail);
      return VERDICT;
    },
    // Records who would have gone to the LLM batch, and declines, so the inline path runs.
    submit: async (_u, _op, requests) => {
      for (const r of requests) submitted.push(r.user.match(/<(.+)>/)![1]);
      return null;
    },
    continueLater: async () => {},
    ...(decider ? { openDecider: async () => decider } : {}),
  };
}

async function reset(): Promise<string> {
  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  await db.delete(aiBatchJobs).where(eq(aiBatchJobs.userId, USER));
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, aiProvider: "gemini", geminiApiKeyEncrypted: encrypt("fake-key") });
  const [job] = await db
    .insert(imports)
    .values({ userId: USER, importType: "gmail_recruiter_scan", status: "processing", stats: { scanIsFull: true } })
    .returning();
  return job.id;
}

async function candidates(importId: string) {
  const db = await getDb();
  const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, importId) });
  return rows.map((r) => ({ email: (r.payload as { email: string }).email, status: r.status }));
}

run(async () => {
  console.log("Without a decider, the scan is the scan it always was");
  {
    const importId = await reset();
    const classified: string[] = [];
    const submitted: string[] = [];
    await runGmailRecruiterScanJob(importId, depsWith(null, classified, submitted));
    const rows = await candidates(importId);
    check("only keyword matches become candidates",
      rows.map((r) => r.email).sort().join(",") === "jo@agency.example,pat@vendor.example", rows.map((r) => r.email).join(","));
    check("…and every one of them goes to the LLM", submitted.sort().join(",") === "jo@agency.example,pat@vendor.example", submitted.join(","));
  }

  console.log("\nWith a decider");
  {
    const importId = await reset();
    const classified: string[] = [];
    const submitted: string[] = [];
    const decider = scriptedDecider();
    await runGmailRecruiterScanJob(importId, depsWith(decider, classified, submitted));
    const rows = await candidates(importId);
    const emails = rows.map((r) => r.email).sort();
    check("the hiring manager the keywords missed becomes a candidate", emails.includes("sam@startup.example"), emails.join(","));
    check("the newsletter does not", !emails.includes("news@digest.example"));
    check("the keyword matches still do", emails.includes("jo@agency.example") && emails.includes("pat@vendor.example"));

    check("the vendor Jev rules out never reaches the LLM batch", !submitted.includes("pat@vendor.example"), submitted.join(","));
    check("…nor the inline classifier", !classified.includes("pat@vendor.example"), classified.join(","));
    check("…and is settled as a skipped row", rows.find((r) => r.email === "pat@vendor.example")?.status === "skipped");
    check("everyone else is classified as before",
      submitted.sort().join(",") === "jo@agency.example,sam@startup.example", submitted.join(","));

    const db = await getDb();
    const job = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    check("the rejection is counted", (job?.stats?.sendersRejected ?? 0) >= 1, JSON.stringify(job?.stats));
    check("the scan completes", job?.status === "completed", String(job?.status));
    check("the decider was asked in discovery and at the gate",
      decider.asked.includes("recruiter.prefilter") && decider.asked.includes("recruiter.gate"), decider.asked.join(","));
  }

  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log(failures === 0 ? "\nAll Jev recruiter-scan checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
});
