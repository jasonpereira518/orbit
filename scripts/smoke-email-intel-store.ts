/**
 * The email-insights store: idempotent upserts, rule events that follow the thread, and a
 * delete that touches only one account. PGlite, no network.
 * Run: npx tsx scripts/smoke-email-intel-store.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailEvents, emailThreads, userSettings } from "../src/db/schema";
import {
  deleteEmailIntelData,
  knownThreadVersions,
  upsertThreadResult,
} from "../src/lib/email-intel/store";
import type { ThreadResult } from "../src/lib/email-intel/types";
import { ensureUserSettings } from "../src/lib/user-settings";

const A = "smoke-eis-a";
const B = "smoke-eis-b";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const base = (over: Partial<ThreadResult>): ThreadResult => ({
  threadId: "t1",
  lastMessageId: "m1",
  subject: "Thank you for applying",
  participants: ["no-reply@stripe.com"],
  lastDirection: "in",
  decision: "ats_rule",
  triageScore: 0,
  event: {
    kind: "process_update",
    stage: "applied",
    company: "Stripe",
    summary: "Applied — Stripe",
    evidenceQuote: "We have received your application.",
    occurredAt: new Date("2026-09-29T12:00:00Z"),
    confidence: 0.9,
  },
  ...over,
});

async function rows(userId: string) {
  const db = await getDb();
  return {
    threads: await db.select().from(emailThreads).where(eq(emailThreads.userId, userId)),
    events: await db.select().from(emailEvents).where(eq(emailEvents.userId, userId)),
  };
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, [A, B]));
  for (const u of [A, B]) await ensureUserSettings(u);

  console.log("\nUpsert");
  const first = await upsertThreadResult(A, base({}));
  check("a new thread is a change", first.changed);
  let r = await rows(A);
  check("one thread row", r.threads.length === 1);
  check("an ATS thread is done", r.threads[0]!.status === "done");
  check("one rule event", r.events.length === 1 && r.events[0]!.stage === "applied");

  const again = await upsertThreadResult(A, base({}));
  check("the same last message is not a change", !again.changed);
  r = await rows(A);
  check("still one thread and one event", r.threads.length === 1 && r.events.length === 1);

  const moved = await upsertThreadResult(
    A,
    base({
      lastMessageId: "m2",
      event: { ...base({}).event!, stage: "interviewing", summary: "Interviewing — Stripe" },
    })
  );
  check("a new message is a change", moved.changed);
  r = await rows(A);
  check("the stage followed the thread", r.events.length === 1 && r.events[0]!.stage === "interviewing");
  check("the last message id advanced", r.threads[0]!.lastMessageId === "m2");

  console.log("\nStatuses");
  await upsertThreadResult(A, base({ threadId: "t2", decision: "classify", event: null }));
  await upsertThreadResult(A, base({ threadId: "t3", decision: "skipped", subject: "", participants: [], event: null }));
  r = await rows(A);
  const status = (id: string) => r.threads.find((t) => t.threadId === id)?.status;
  check("a human thread waits for the extractor", status("t2") === "pending_ai");
  check("a skipped thread is remembered", status("t3") === "skipped");
  check("neither made an event", r.events.length === 1);

  await upsertThreadResult(A, base({ lastMessageId: "m3", decision: "skipped", subject: "", participants: [], event: null }));
  r = await rows(A);
  check("a thread that turns irrelevant loses its event", r.events.length === 0);

  console.log("\nKnown versions");
  const known = await knownThreadVersions(A, ["t1", "t2", "nope"]);
  check("returns the stored last message ids", known.get("t1") === "m3" && known.get("t2") === "m1");
  check("omits unknown threads", !known.has("nope"));
  check("an empty request is an empty map", (await knownThreadVersions(A, [])).size === 0);

  console.log("\nIsolation and delete");
  await upsertThreadResult(B, base({}));
  check("another account keeps its own row for the same thread id", (await rows(B)).threads.length === 1);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(eq(userSettings.userId, A));
  await deleteEmailIntelData(A);
  check("delete clears the account's threads", (await rows(A)).threads.length === 0);
  check("and its events", (await rows(A)).events.length === 0);
  check("but not another account's", (await rows(B)).threads.length === 1);
  const [settings] = await db.select().from(userSettings).where(eq(userSettings.userId, A));
  check("and switches the feature off", settings!.emailIntelEnabled === 0);

  await db.delete(emailThreads).where(inArray(emailThreads.userId, [A, B]));
  console.log("\nAll email-intel store checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
