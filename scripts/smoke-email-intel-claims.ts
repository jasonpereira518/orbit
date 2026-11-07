/**
 * The extraction claim lifecycle: who is claimable, that a claim is exclusive, that a lost
 * claim writes nothing, that stalls end in `failed`, and that parking works. PGlite, no network.
 * Run: npx tsx scripts/smoke-email-intel-claims.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailEvents, emailThreads, userSettings } from "../src/db/schema";
import {
  CLAIM_LEASE_MS,
  MAX_STALL_RESUMES,
  accountsWithPendingThreads,
  claimPendingThreads,
  deferPending,
  recoverStalledClaims,
  releaseThread,
  settleExtraction,
  upsertThreadResult,
} from "../src/lib/email-intel/store";
import type { ExtractedEvent, ThreadResult } from "../src/lib/email-intel/types";
import { ensureUserSettings } from "../src/lib/user-settings";

const A = "smoke-eic-a";
const B = "smoke-eic-b";
const OFF = "smoke-eic-off";
const USERS = [A, B, OFF];
const T0 = new Date("2026-09-30T12:00:00Z");
const MIN = 60_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const pending = (threadId: string, over: Partial<ThreadResult> = {}): ThreadResult => ({
  threadId,
  lastMessageId: `${threadId}-m1`,
  subject: `Subject ${threadId}`,
  participants: ["dana@acme.example"],
  lastDirection: "in",
  decision: "classify",
  triageScore: 3,
  event: null,
  ...over,
});

const event = (over: Partial<ExtractedEvent> = {}): ExtractedEvent => ({
  kind: "job_posting",
  company: "Acme",
  role: "Engineer",
  stage: null,
  summary: "Acme is hiring an engineer.",
  evidenceQuote: "We are hiring an engineer",
  occurredAt: new Date("2026-09-29T12:00:00Z"),
  dueAt: null,
  confidence: 0.9,
  people: [{ name: "Dana Kim", email: "dana@acme.example", title: "Recruiter" }],
  asks: ["Reply with availability"],
  ...over,
});

async function row(userId: string, threadId: string) {
  const db = await getDb();
  const all = await db.select().from(emailThreads).where(eq(emailThreads.userId, userId));
  const found = all.find((t) => t.threadId === threadId);
  if (!found) throw new Error(`no thread ${threadId} for ${userId}`);
  return found;
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  for (const u of USERS) await ensureUserSettings(u);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(inArray(userSettings.userId, [A, B]));
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(eq(userSettings.userId, OFF));

  console.log("\nWho is claimable");
  await upsertThreadResult(A, pending("a1"));
  await upsertThreadResult(A, pending("a2"));
  await upsertThreadResult(A, pending("a3"));
  await upsertThreadResult(B, pending("b1"));
  await upsertThreadResult(OFF, pending("o1"));
  await upsertThreadResult(A, pending("a-done", { decision: "ats_rule" }));
  const accounts = await accountsWithPendingThreads(T0, 10);
  check("only opted-in accounts with waiting threads", accounts.slice().sort().join() === [A, B].join(), accounts.join());
  check("the limit is honoured", (await accountsWithPendingThreads(T0, 1)).length === 1);

  console.log("\nClaiming");
  const first = await claimPendingThreads(A, 2, T0);
  check("a claim takes at most the limit", first.length === 2);
  check("a claim carries what the extractor needs", first[0]!.subject.startsWith("Subject ") && first[0]!.participants[0] === "dana@acme.example" && first[0]!.claimToken.length > 20);
  const second = await claimPendingThreads(A, 5, T0);
  check("a claimed thread cannot be claimed again", second.length === 1, String(second.length));
  check("the ATS thread is never claimable", ![...first, ...second].some((c) => c.threadId === "a-done"));
  check("claimed rows say so", (await row(A, first[0]!.threadId)).status === "claimed");

  console.log("\nSettling");
  const held = first[0]!;
  const ok = await settleExtraction(A, held, [event(), event({ kind: "news", company: "Other", role: null, people: [], asks: [] })]);
  check("settling a held claim succeeds", ok);
  let events = await db.select().from(emailEvents).where(eq(emailEvents.userId, A));
  check("both events were written as ai events", events.length === 2 && events.every((e) => e.source === "ai"));
  check("the thread is done and the claim cleared", (await row(A, held.threadId)).status === "done" && (await row(A, held.threadId)).claimToken === null);
  check("people and asks are stored", events.some((e) => Array.isArray(e.people) && e.people.length === 1 && e.asks.length === 1));

  const again = await settleExtraction(A, held, [event({ company: "Changed" })]);
  check("settling twice is refused: the claim is gone", again === false);
  events = await db.select().from(emailEvents).where(eq(emailEvents.userId, A));
  check("and wrote nothing", events.length === 2);

  console.log("\nA newer message resets the thread mid-claim");
  const racing = second[0]!;
  await upsertThreadResult(A, pending(racing.threadId, { lastMessageId: `${racing.threadId}-m2` }));
  const lost = await settleExtraction(A, racing, [event({ company: "Stale" })]);
  check("the extraction is dropped", lost === false);
  events = await db.select().from(emailEvents).where(eq(emailEvents.userId, A));
  check("no stale events were written", !events.some((e) => e.company === "Stale"));
  check("the thread is waiting again for its new message", (await row(A, racing.threadId)).status === "pending_ai");

  console.log("\nParking");
  const c1 = (await claimPendingThreads(A, 1, T0))[0]!;
  await releaseThread(c1, { notBefore: new Date(T0.getTime() + 6 * 60 * MIN), countStall: false });
  const afterRelease = await row(A, c1.threadId);
  check("a released thread is pending again", afterRelease.status === "pending_ai" && afterRelease.claimToken === null);
  check("without a counted stall", afterRelease.stallResumes === 0);
  check("it is not claimable before its time", (await claimPendingThreads(A, 5, new Date(T0.getTime() + 60 * MIN))).every((c) => c.threadId !== c1.threadId));
  check("it is claimable after", (await claimPendingThreads(A, 5, new Date(T0.getTime() + 7 * 60 * MIN))).some((c) => c.threadId === c1.threadId));

  console.log("\nStalls end in failed");
  await upsertThreadResult(B, pending("b2"));
  for (let i = 1; i <= MAX_STALL_RESUMES; i++) {
    const c = (await claimPendingThreads(B, 5, T0)).find((x) => x.threadId === "b2");
    check(`attempt ${i} can claim the thread`, Boolean(c));
    await releaseThread(c!, { notBefore: null, countStall: true });
  }
  const failed = await row(B, "b2");
  check(`after ${MAX_STALL_RESUMES} counted stalls it is failed`, failed.status === "failed" && failed.stallResumes === MAX_STALL_RESUMES, `${failed.status} ${failed.stallResumes}`);
  check("a failed thread is never claimed", (await claimPendingThreads(B, 5, T0)).every((c) => c.threadId !== "b2"));

  console.log("\nA dead runner");
  await upsertThreadResult(B, pending("b3"));
  const stuck = (await claimPendingThreads(B, 5, T0)).find((x) => x.threadId === "b3")!;
  check("inside the lease nothing is recovered", (await recoverStalledClaims(new Date(T0.getTime() + CLAIM_LEASE_MS - MIN))) === 0);
  const recovered = await recoverStalledClaims(new Date(T0.getTime() + CLAIM_LEASE_MS + MIN));
  check("past the lease the claim comes back", recovered >= 1);
  const back = await row(B, stuck.threadId);
  check("as pending with one stall counted", back.status === "pending_ai" && back.stallResumes === 1, `${back.status} ${back.stallResumes}`);
  check("and the dead runner's token is void", (await settleExtraction(B, stuck, [event()])) === false);

  console.log("\nDeferring an account");
  await upsertThreadResult(A, pending("a9"));
  await deferPending(A, new Date(T0.getTime() + 24 * 60 * MIN));
  check("a deferred account has nothing claimable", (await claimPendingThreads(A, 5, new Date(T0.getTime() + 8 * 60 * MIN))).length === 0);
  check("and is not listed", !(await accountsWithPendingThreads(new Date(T0.getTime() + 8 * 60 * MIN), 10)).includes(A));

  await db.delete(emailThreads).where(inArray(emailThreads.userId, USERS));
  console.log("\nAll email-intel claim checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
