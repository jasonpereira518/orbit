/**
 * The extraction runner: who it serves, what it writes, and every way it stops. PGlite plus a
 * fake Gmail, a fake model and fake gates. No key, no network.
 * Run: npx tsx scripts/smoke-email-intel-extractor.ts
 */
import "./smoke/_env";

import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailEvents, emailThreads, rateLimitBuckets, userSettings } from "../src/db/schema";
import { AiAccessError } from "../src/lib/ai-access";
import {
  EXTRACT_CLAIM_PER_ACCOUNT,
  KEY_PROBLEM_COOLDOWN_MS,
  runEmailIntelExtraction,
  type EmailIntelExtractDeps,
  type EmailIntelExtractGmail,
} from "../src/lib/email-intel/extractor";
import { upsertThreadResult } from "../src/lib/email-intel/store";
import type { ExtractionResult, ThreadResult } from "../src/lib/email-intel/types";
import type { GmailMessageContent } from "../src/lib/gmail";
import { consumeBucket, RATE_LIMITS } from "../src/lib/rate-limit";
import { utcDayKey } from "../src/lib/timeline-cost";
import { ensureUserSettings } from "../src/lib/user-settings";

const OK = "smoke-eix-ok";
const NOAI = "smoke-eix-noai";
const KEY = "smoke-eix-key";
const CAP = "smoke-eix-cap";
const BAD = "smoke-eix-bad";
const NOELIG = "smoke-eix-noelig";
const EMPTY = "smoke-eix-empty";
const USERS = [OK, NOAI, KEY, CAP, BAD, NOELIG, EMPTY];
const ME = "me@example.com";
const T0 = new Date("2026-09-30T12:00:00Z");
const HOUR = 60 * 60_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const pending = (threadId: string): ThreadResult => ({
  threadId,
  lastMessageId: `${threadId}-m1`,
  subject: `Subject ${threadId}`,
  participants: ["dana@acme.example"],
  lastDirection: "in",
  decision: "classify",
  triageScore: 3,
  event: null,
});

const message = (id: string): GmailMessageContent => ({
  id,
  threadId: "t",
  from: "Dana Kim <dana@acme.example>",
  to: `Me <${ME}>`,
  subject: "Hello",
  snippet: "snippet",
  internalDate: T0.getTime() - HOUR,
  listUnsubscribe: "",
  listId: "",
  precedence: "",
  body: "We are hiring an engineer at Acme.",
});

type Calls = { tokens: string[]; fetches: string[]; extracts: string[] };
function fakeGmail(calls: Calls, opts: { emptyFor?: string[] } = {}): EmailIntelExtractGmail {
  return {
    accessToken: async (userId) => {
      calls.tokens.push(userId);
      return "tok";
    },
    fetchThreadMessages: async (_token, threadId) => {
      calls.fetches.push(threadId);
      return opts.emptyFor?.includes(threadId) ? [] : [message(`${threadId}-m1`)];
    },
  };
}

const okResult = (summary: string): ExtractionResult => ({
  events: [
    {
      kind: "job_posting",
      company: "Acme",
      role: "Engineer",
      stage: null,
      summary,
      evidenceQuote: "We are hiring an engineer at Acme.",
      occurredAt: T0,
      dueAt: null,
      confidence: 0.9,
      people: [],
      asks: [],
    },
  ],
  rejected: { badKind: 1, lowConfidence: 0, unverifiable: 0, empty: 0, suspicious: 0, duplicate: 0, capped: 0 },
});

function deps(calls: Calls, now: Date, extra: Partial<EmailIntelExtractDeps> = {}): EmailIntelExtractDeps {
  return {
    now,
    gmail: fakeGmail(calls),
    connection: async () => ({ email: ME, canRead: true }),
    eligible: async (userId) => userId !== NOELIG,
    canUseAi: async (userId) => userId !== NOAI,
    extract: async (userId, input) => {
      calls.extracts.push(`${userId}:${input.subject}`);
      if (userId === KEY) throw new AiAccessError("key_required");
      if (userId === BAD) throw new Error("the answer was not JSON");
      return okResult(`Summary for ${input.subject}`);
    },
    ...extra,
  };
}

const freshCalls = (): Calls => ({ tokens: [], fetches: [], extracts: [] });

/** Arms exactly `armed`, and only those. */
async function arm(armed: string[]) {
  const db = await getDb();
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(inArray(userSettings.userId, USERS));
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(inArray(userSettings.userId, armed));
}
async function threadsOf(userId: string) {
  const db = await getDb();
  return db.select().from(emailThreads).where(eq(emailThreads.userId, userId));
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%smoke-eix-%"));
  for (const u of USERS) await ensureUserSettings(u);

  console.log("\nA healthy account");
  await arm([OK]);
  for (const t of ["o1", "o2", "o3"]) await upsertThreadResult(OK, pending(t));
  let calls = freshCalls();
  let stats = await runEmailIntelExtraction(deps(calls, T0));
  check("one account was served", stats.accounts === 1, JSON.stringify(stats));
  check("all three threads were extracted", stats.extracted === 3 && stats.claimed === 3, JSON.stringify(stats));
  check("each thread was read from Gmail once", calls.fetches.length === 3);
  const okThreads = await threadsOf(OK);
  check("they are done", okThreads.every((t) => t.status === "done"));
  const events = await db.select().from(emailEvents).where(eq(emailEvents.userId, OK));
  check("one ai event per thread", events.length === 3 && events.every((e) => e.source === "ai" && e.summary.startsWith("Summary for")));
  check("the model got the thread's own subject", calls.extracts.every((e) => e.includes("Subject o")));
  check("rejection counts add up in the stats", stats.rejected.badKind === 3, JSON.stringify(stats.rejected));
  check("a second run has nothing to do", (await runEmailIntelExtraction(deps(freshCalls(), T0))).accounts === 0);

  console.log("\nThe per-run claim limit");
  await arm([EMPTY]);
  for (let i = 0; i < EXTRACT_CLAIM_PER_ACCOUNT + 2; i++) await upsertThreadResult(EMPTY, pending(`e${i}`));
  calls = freshCalls();
  stats = await runEmailIntelExtraction(deps(calls, T0));
  check("an account is served up to the claim limit", stats.claimed === EXTRACT_CLAIM_PER_ACCOUNT, JSON.stringify(stats));
  check("the rest wait for the next run", (await threadsOf(EMPTY)).filter((t) => t.status === "pending_ai").length === 2);

  console.log("\nNo AI available");
  await arm([NOAI]);
  await upsertThreadResult(NOAI, pending("n1"));
  calls = freshCalls();
  stats = await runEmailIntelExtraction(deps(calls, T0));
  check("the account is counted as having no AI", stats.noAi === 1 && stats.extracted === 0, JSON.stringify(stats));
  check("no Gmail read and no model call were made", calls.tokens.length === 0 && calls.extracts.length === 0);
  check("its thread waits, parked", (await threadsOf(NOAI))[0]!.status === "pending_ai");
  check("it is not retried an hour later", (await runEmailIntelExtraction(deps(freshCalls(), new Date(T0.getTime() + HOUR)))).accounts === 0);

  console.log("\nPlan or mail access gone");
  await arm([NOELIG]);
  await upsertThreadResult(NOELIG, pending("g1"));
  calls = freshCalls();
  stats = await runEmailIntelExtraction(deps(calls, T0));
  check("an ineligible account is counted and skipped", stats.ineligible === 1 && calls.extracts.length === 0, JSON.stringify(stats));

  console.log("\nA key problem is not the thread's fault");
  await arm([KEY]);
  await upsertThreadResult(KEY, pending("k1"));
  await upsertThreadResult(KEY, pending("k2"));
  calls = freshCalls();
  stats = await runEmailIntelExtraction(deps(calls, T0));
  check("it is counted as a key problem", stats.keyProblems === 1, JSON.stringify(stats));
  check("the account stops after the first failure", calls.extracts.length === 1, String(calls.extracts.length));
  const keyThreads = await threadsOf(KEY);
  check("both threads are waiting again", keyThreads.every((t) => t.status === "pending_ai"));
  check("with no stall counted", keyThreads.every((t) => t.stallResumes === 0));
  check("parked for the cooldown", keyThreads.every((t) => t.claimedAt !== null && t.claimedAt.getTime() === T0.getTime() + KEY_PROBLEM_COOLDOWN_MS), keyThreads.map((t) => String(t.claimedAt)).join());
  check("not retried inside it", (await runEmailIntelExtraction(deps(freshCalls(), new Date(T0.getTime() + 2 * HOUR)))).accounts === 0);

  console.log("\nThe daily cap");
  await arm([CAP]);
  await upsertThreadResult(CAP, pending("c1"));
  const capNow = new Date(T0.getTime() + 30 * HOUR);
  await consumeBucket("email-intel-extract-daily", `${CAP}:${utcDayKey(capNow)}`, RATE_LIMITS.emailIntelExtractDaily, RATE_LIMITS.emailIntelExtractDaily.limit);
  calls = freshCalls();
  stats = await runEmailIntelExtraction(deps(calls, capNow));
  check("the cap stops the account", stats.budgetStops === 1 && calls.extracts.length === 0, JSON.stringify(stats));
  const cap = (await threadsOf(CAP))[0]!;
  check("the thread waits for tomorrow", cap.status === "pending_ai" && cap.claimedAt?.toISOString() === "2026-10-02T00:00:00.000Z", String(cap.claimedAt));

  console.log("\nAn unreadable thread");
  await arm([BAD]);
  await upsertThreadResult(BAD, pending("x1"));
  for (let i = 0; i < 3; i++) await runEmailIntelExtraction(deps(freshCalls(), new Date(T0.getTime() + i * HOUR)));
  const bad = (await threadsOf(BAD))[0]!;
  check("three counted failures end in failed", bad.status === "failed" && bad.stallResumes === 3, `${bad.status} ${bad.stallResumes}`);
  check("and no event was invented", (await db.select().from(emailEvents).where(eq(emailEvents.userId, BAD))).length === 0);

  console.log("\nGmail returns nothing");
  await arm([OK]);
  await upsertThreadResult(OK, pending("gone"));
  calls = freshCalls();
  await runEmailIntelExtraction(deps(calls, new Date(T0.getTime() + 40 * HOUR), { gmail: fakeGmail(calls, { emptyFor: ["gone"] }) }));
  const gone = (await threadsOf(OK)).find((t) => t.threadId === "gone")!;
  check("it counts a stall and no model call was made", gone.stallResumes === 1 && calls.extracts.length === 0, `${gone.stallResumes} ${calls.extracts.length}`);

  console.log("\nThe time budget");
  await arm([OK]);
  await upsertThreadResult(OK, pending("late"));
  calls = freshCalls();
  stats = await runEmailIntelExtraction(deps(calls, new Date(T0.getTime() + 60 * HOUR), { deadline: Date.now() - 1 }));
  check("nothing starts past the deadline", stats.accounts === 0 && calls.tokens.length === 0, JSON.stringify(stats));

  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "%smoke-eix-%"));
  console.log("\nAll email-intel extractor checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
