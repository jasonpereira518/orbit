/**
 * The write-back queue.
 *
 * Enqueue must be idempotent — the same follow-up must not create two tasks in someone's
 * Reminders — and the drain must survive one connector failing without stalling the queue.
 *
 * "Idempotent" here means "do not double-queue an action that has not been sent yet," not
 * "never do this action again": a delivered or dead row must still be revivable, or a
 * completed follow-up could never be re-sent and a provider outage would permanently poison
 * that key. The re-enqueue and revival sections below are the regression tests for that.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorOutbox, externalLinks } from "../src/db/schema";
import {
  drainOutbox,
  enqueueOutbox,
  findExternalLink,
  recordExternalLink,
  MAX_OUTBOX_ATTEMPTS,
} from "../src/lib/connectors/outbox";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-outbox";

run(async () => {
  const db = await getDb();
  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  await db.delete(externalLinks).where(eq(externalLinks.userId, USER));

  console.log("enqueue");
  const first = await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-1",
    payload: { title: "Follow up with Ada" },
  });
  const again = await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-1",
    payload: { title: "Follow up with Ada" },
  });
  check("the first enqueue creates a row", first !== null);
  check("a still-pending row is not re-queued", again === null);

  const rows = await db.select().from(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  check("exactly one queued row", rows.length === 1, String(rows.length));
  check("it starts pending", rows[0]?.status === "pending");

  console.log("\ndrain");
  const handled: string[] = [];
  const stats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async (item) => {
      handled.push(item.entityId);
      return { ok: true, remoteId: "remote-1" };
    },
  });
  check("the item was attempted", stats.attempted === 1, JSON.stringify(stats));
  check("the item was delivered", stats.delivered === 1);
  check("the handler saw the entity", handled[0] === "rem-1");

  const link = await findExternalLink(USER, "apple_reminders", "reminder", "rem-1");
  check("delivery records the remote id", link?.remoteId === "remote-1");

  console.log("\nre-enqueue after delivery must queue again (IMPORTANT-1 regression)");
  // Without this, a completed follow-up could never be re-sent: the user re-opens it,
  // completes it a second time, and `enqueueOutbox` silently no-ops against the delivered
  // row. This check fails against the old `onConflictDoNothing()` implementation — verified
  // by hand before applying the fix below.
  const resend = await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-1",
    payload: { title: "Follow up with Ada, again" },
  });
  check("a delivered row can be queued again", resend !== null);
  const [revivedDelivered] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-1"));
  check("the revived row is pending", revivedDelivered?.status === "pending");
  check("attempts reset to zero", revivedDelivered?.attempts === 0);
  check("deliveredAt is cleared", revivedDelivered?.deliveredAt === null);
  check("nextAttemptAt is set", revivedDelivered?.nextAttemptAt !== null);
  check(
    "the payload is the fresh one",
    (revivedDelivered?.payload as { title?: string } | null)?.title ===
      "Follow up with Ada, again"
  );

  // Drive the resend to delivery too, with a different remote id, to prove the whole path —
  // not just the enqueue — actually works end to end.
  const resendHandled: string[] = [];
  const resendStats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async (item) => {
      resendHandled.push(item.entityId);
      return { ok: true, remoteId: "remote-1-again" };
    },
  });
  check("the resend was delivered", resendStats.delivered === 1, JSON.stringify(resendStats));
  check("the handler saw it again", resendHandled[0] === "rem-1");

  console.log("\nfailure backs off rather than dying");
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-2",
    payload: { title: "Second" },
  });
  const failStats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async () => {
      throw new Error("provider down");
    },
  });
  check("the failure is counted", failStats.failed === 1, JSON.stringify(failStats));
  const [failed] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-2"));
  check("it stays pending for a retry", failed?.status === "pending");
  check("it is rescheduled", failed?.nextAttemptAt !== null);
  check("the attempt is recorded", (failed?.attempts ?? 0) === 1);

  console.log("\nattempt exhaustion goes dead, not stuck retrying forever");
  // Drive the same row through the rest of MAX_OUTBOX_ATTEMPTS failures. It is already at
  // attempt 1 from above, so MAX_OUTBOX_ATTEMPTS - 1 more failures should exhaust it — this
  // is the arithmetic that silently retries forever if `exhausted` is off by one.
  for (let i = 1; i < MAX_OUTBOX_ATTEMPTS; i++) {
    await db
      .update(connectorOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(connectorOutbox.entityId, "rem-2"));
    await drainOutbox({
      budgetMs: 5_000,
      max: 10,
      deliver: async () => {
        throw new Error("still down");
      },
    });
  }
  const [dead] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-2"));
  check("it is dead after exhausting its attempts", dead?.status === "dead", String(dead?.status));
  check("attempts stop at the max", dead?.attempts === MAX_OUTBOX_ATTEMPTS, String(dead?.attempts));
  check("a dead item has no next attempt", dead?.nextAttemptAt === null);

  console.log("\na dead row is not picked up by a later drain");
  const deadHandled: string[] = [];
  const deadDrainStats = await drainOutbox({
    budgetMs: 2_000,
    max: 10,
    deliver: async (item) => {
      deadHandled.push(item.entityId);
      return { ok: true, remoteId: "should-not-happen" };
    },
  });
  check(
    "the dead item was not attempted",
    !deadHandled.includes("rem-2"),
    JSON.stringify(deadDrainStats)
  );

  console.log("\na dead row is revived by a new enqueue");
  const revive = await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-2",
    payload: { title: "Second, retried after reconnect" },
  });
  check("a dead row can be queued again", revive !== null);
  const [revivedDead] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-2"));
  check("the revived row is pending", revivedDead?.status === "pending");
  check("attempts reset to zero", revivedDead?.attempts === 0);
  check("lastError is cleared", revivedDead?.lastError === null);
  check("nextAttemptAt is set", revivedDead?.nextAttemptAt !== null);
  // Done with rem-2: clear it so it does not show up as a third due item in the sections
  // below, which are scoped to exactly the rows they enqueue.
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-2"));

  console.log("\ntwo items in one drain: the first failing must not stop the second");
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-a",
    payload: { title: "A" },
  });
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-b",
    payload: { title: "B" },
  });
  let calls = 0;
  const pairHandled: string[] = [];
  const pairStats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async (item) => {
      pairHandled.push(item.entityId);
      calls++;
      if (calls === 1) throw new Error("first one is down");
      return { ok: true, remoteId: `remote-${item.entityId}` };
    },
  });
  check("both items were attempted", pairStats.attempted === 2, JSON.stringify(pairStats));
  check("one delivered, one failed", pairStats.delivered === 1 && pairStats.failed === 1);
  check(
    "both entities were actually handed to deliver",
    pairHandled.includes("rem-a") && pairHandled.includes("rem-b"),
    JSON.stringify(pairHandled)
  );

  console.log("\na per-item timeout is an ordinary failed attempt, not a hang");
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-timeout",
    payload: { title: "Never answers" },
  });
  const timeoutStarted = Date.now();
  const timeoutStats = await drainOutbox({
    // Small on purpose: the per-item bound is min(the module's own ceiling, remaining
    // budget), so a tight budget here forces the timeout path without waiting on the
    // module's full internal ceiling.
    budgetMs: 400,
    max: 10,
    deliver: () => new Promise(() => {}), // deliberately never resolves
  });
  const timeoutElapsedMs = Date.now() - timeoutStarted;
  check("the timeout is counted as a failure", timeoutStats.failed === 1, JSON.stringify(timeoutStats));
  check("it did not block past its budget", timeoutElapsedMs < 5_000, `${timeoutElapsedMs}ms`);
  const [timedOut] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-timeout"));
  check("it stays pending for a retry", timedOut?.status === "pending");
  check("the attempt is recorded", timedOut?.attempts === 1);
  check(
    "the error names the timeout",
    (timedOut?.lastError ?? "").toLowerCase().includes("timed out"),
    String(timedOut?.lastError)
  );

  console.log("\na non-retryable failure goes dead on the first attempt");
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-unbuilt",
    payload: { title: "No connector can take this yet" },
  });
  const nonRetryableStats = await drainOutbox({
    budgetMs: 2_000,
    max: 10,
    deliver: async () => ({ ok: false, error: "cannot receive writes yet", retryable: false }),
  });
  check("it is counted as a failure", nonRetryableStats.failed === 1);
  const [deadOnArrival] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-unbuilt"));
  check("it is dead immediately", deadOnArrival?.status === "dead");
  check(
    "it did not wait for MAX_OUTBOX_ATTEMPTS",
    deadOnArrival?.attempts === 1,
    String(deadOnArrival?.attempts)
  );

  console.log("\nrecordExternalLink updates in place rather than duplicating");
  await recordExternalLink({
    userId: USER,
    connectorId: "apple_reminders",
    entityType: "reminder",
    entityId: "rem-link",
    remoteId: "first-remote-id",
  });
  await recordExternalLink({
    userId: USER,
    connectorId: "apple_reminders",
    entityType: "reminder",
    entityId: "rem-link",
    remoteId: "second-remote-id",
  });
  const relinked = await findExternalLink(USER, "apple_reminders", "reminder", "rem-link");
  check("the second call's remote id wins", relinked?.remoteId === "second-remote-id");
  const [{ n: linkCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(externalLinks)
    .where(eq(externalLinks.entityId, "rem-link"));
  check("only one row exists for that key", Number(linkCount) === 1, String(linkCount));

  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  await db.delete(externalLinks).where(eq(externalLinks.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outbox checks passed.");
});
