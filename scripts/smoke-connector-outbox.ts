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
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorOutbox, externalLinks } from "../src/db/schema";
import {
  drainOutbox,
  enqueueOutbox,
  findExternalLink,
  MAX_OUTBOX_ATTEMPTS,
  CLAIM_LEASE_MS,
  backoffBoundsMs,
  type DeliverResult,
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
  // THE point of `external_links`, and the one thing nothing here used to assert: a
  // re-delivery must be handed the remote id the FIRST delivery recorded. Without it the
  // connector has no way to know the thing already exists, so it creates a SECOND task in
  // someone's Reminders instead of updating the first — the exact harm named in this module's
  // header. Mutating `remoteId: link?.remoteId ?? null` to `remoteId: null` in
  // src/lib/connectors/outbox.ts passed all 79 checks before this one existed.
  const resendSawRemoteIds: (string | null)[] = [];
  const resendStats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async (item) => {
      resendHandled.push(item.entityId);
      resendSawRemoteIds.push(item.remoteId);
      return { ok: true, remoteId: "remote-1-again" };
    },
  });
  check("the resend was delivered", resendStats.delivered === 1, JSON.stringify(resendStats));
  check("the handler saw it again", resendHandled[0] === "rem-1");
  check(
    "the re-delivery carries the first delivery's remote id",
    resendSawRemoteIds[0] === "remote-1",
    JSON.stringify(resendSawRemoteIds)
  );
  // And the drain's link write updates that row in place rather than duplicating it: the
  // unique key is (user, connector, entity type, entity id), so a second remote id for the
  // same entity must replace the first, not add a row a later lookup could pick either of.
  const relinked = await findExternalLink(USER, "apple_reminders", "reminder", "rem-1");
  check("the newer delivery's remote id wins", relinked?.remoteId === "remote-1-again", String(relinked?.remoteId));
  const [{ n: linkCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(externalLinks)
    .where(eq(externalLinks.entityId, "rem-1"));
  check("only one link row exists for that key", Number(linkCount) === 1, String(linkCount));

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
  // No `backoffMs` override anywhere in this section, so this is the REAL jittered ladder. The
  // anchor section below pins the duration to isolate the anchor; this pins the duration to
  // the ladder, so an override there can never become the only thing under test.
  const failBounds = backoffBoundsMs(failed?.attempts ?? 1);
  const failGap =
    (failed?.nextAttemptAt?.getTime() ?? 0) - (failed?.lastAttemptedAt?.getTime() ?? 0);
  check(
    "the default retry delay is a step on the real ladder",
    failGap >= failBounds.min && failGap <= failBounds.max,
    `gap=${failGap}ms, ladder band ${failBounds.min}-${failBounds.max}ms`
  );

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
    // Comfortably above ITEM_BUDGET_FLOOR_MS (2s): at exactly the floor this drain could stop
    // before claiming anything at all and the check below would pass for the wrong reason.
    budgetMs: 5_000,
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
    // Above ITEM_BUDGET_FLOOR_MS (2s) so the item is actually claimed rather than skipped by
    // the NEW-1 floor guard, but still well under the module's own 15s ceiling, so a tight
    // budget here forces the timeout path without waiting on the full internal ceiling.
    budgetMs: 3_000,
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
    budgetMs: 3_000, // above ITEM_BUDGET_FLOOR_MS; see the timeout test above
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

  console.log(
    "\na drain with too little budget left must not claim-then-timeout (NEW-1 regression)"
  );
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-floor",
    payload: { title: "tight budget" },
  });
  let floorDeliverCalls = 0;
  const floorStats = await drainOutbox({
    // Far below ITEM_BUDGET_FLOOR_MS. Without the floor guard, this still claims the row (the
    // deadline check at loop-top only asked "any budget at all," not "enough to be worth it"),
    // then hands `deliver` a near-zero timeout — so a perfectly healthy 500ms delivery below
    // gets charged a failed attempt for a call that never had a chance to finish.
    budgetMs: 50,
    max: 10,
    deliver: async () => {
      floorDeliverCalls++;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { ok: true, remoteId: "remote-floor" };
    },
  });
  check("nothing was attempted", floorStats.attempted === 0, JSON.stringify(floorStats));
  check("deliver was never invoked", floorDeliverCalls === 0);
  const [untouchedFloor] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-floor"));
  check("attempts stayed at zero", untouchedFloor?.attempts === 0, String(untouchedFloor?.attempts));
  check("still pending", untouchedFloor?.status === "pending");
  check("no error was recorded", untouchedFloor?.lastError === null);
  // Done with this one: clear it so it doesn't linger as a due row for a later section.
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-floor"));

  console.log(
    "\ntwo overlapping drains over one due row must call deliver exactly once (NEW-2 regression)"
  );
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-race",
    payload: { title: "raced" },
  });
  let raceDeliverCalls = 0;
  const raceHandled: string[] = [];
  // Models the reviewer's probe: one drain claims the row and is mid-delivery (slow on
  // purpose) when a second, independently-timed drain starts its own SELECT over the same
  // due row. The attempts-only CAS does not protect against this — the second drain reads
  // the fresh, post-claim `attempts` value and its own CAS matches it — only a lease that
  // pushes `nextAttemptAt` into the future closes it.
  const slowDrain = drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async (item) => {
      raceDeliverCalls++;
      raceHandled.push(`slow:${item.entityId}@attempt${item.attempts}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { ok: true, remoteId: "remote-race-slow" };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const fastDrain = drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async (item) => {
      raceDeliverCalls++;
      raceHandled.push(`fast:${item.entityId}@attempt${item.attempts}`);
      return { ok: true, remoteId: "remote-race-fast" };
    },
  });
  const [slowStats, fastStats] = await Promise.all([slowDrain, fastDrain]);
  check(
    "deliver was invoked exactly once across both drains",
    raceDeliverCalls === 1,
    JSON.stringify({ raceDeliverCalls, raceHandled })
  );
  check(
    "exactly one of the two drains delivered it",
    slowStats.delivered + fastStats.delivered === 1,
    JSON.stringify({ slowStats, fastStats })
  );
  const [racedRow] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-race"));
  check("the row ends delivered exactly once", racedRow?.status === "delivered");

  console.log(
    "\nthe lease anchors to claim time, not drain start (NEW-3 regression)"
  );
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-anchor-a",
    payload: { title: "goes first, slow" },
  });
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-anchor-b",
    payload: { title: "goes second" },
  });
  // Force the ordering the `due` query relies on — both were enqueued moments apart, too
  // close to trust for a deterministic test.
  await db
    .update(connectorOutbox)
    .set({ nextAttemptAt: new Date(Date.now() - 10_000) })
    .where(eq(connectorOutbox.entityId, "rem-anchor-a"));
  await db
    .update(connectorOutbox)
    .set({ nextAttemptAt: new Date(Date.now() - 5_000) })
    .where(eq(connectorOutbox.entityId, "rem-anchor-b"));

  const ANCHOR_DELAY_MS = 2_500; // long enough to distinguish drain-start anchoring from claim-time anchoring
  const anchorDrainStart = Date.now();
  // An object rather than separate `let`s: captured and mutated from inside the `deliver`
  // callback below, and a plain object property sidesteps TypeScript's closure-narrowing
  // quirks with reassigned `let`s read after an `await` boundary.
  const anchorCapture: { claimedAt: number | null; leaseAt: Date | null } = {
    claimedAt: null,
    leaseAt: null,
  };
  await drainOutbox({
    budgetMs: 20_000,
    max: 10,
    deliver: async (item) => {
      if (item.entityId === "rem-anchor-a") {
        await new Promise((resolve) => setTimeout(resolve, ANCHOR_DELAY_MS));
        return { ok: true, remoteId: "remote-anchor-a" };
      }
      // item B: captured the instant it was actually claimed (deliver is called right after
      // the claim commits), then reads B's own freshly-set lease straight from the row.
      // The lease lives in `claimedUntil` now, not `nextAttemptAt` — same property under
      // test (an item claimed late in a long drain is leased from ITS claim, not from the
      // drain's start), read off the column that now holds it.
      anchorCapture.claimedAt = Date.now();
      const [row] = await db
        .select()
        .from(connectorOutbox)
        .where(eq(connectorOutbox.entityId, "rem-anchor-b"));
      anchorCapture.leaseAt = row?.claimedUntil ?? null;
      return { ok: true, remoteId: "remote-anchor-b" };
    },
  });
  const elapsedBeforeBClaimed = (anchorCapture.claimedAt ?? 0) - anchorDrainStart;
  check(
    "B was actually claimed well after the drain started",
    elapsedBeforeBClaimed > ANCHOR_DELAY_MS - 300,
    `${elapsedBeforeBClaimed}ms`
  );
  const leaseRemainingFromClaim =
    (anchorCapture.leaseAt?.getTime() ?? 0) - (anchorCapture.claimedAt ?? 0);
  check(
    "the lease is anchored to when B was claimed, not when the drain started",
    Math.abs(leaseRemainingFromClaim - CLAIM_LEASE_MS) < 1_000,
    `leaseRemainingFromClaim=${leaseRemainingFromClaim}ms, expected ~${CLAIM_LEASE_MS}ms`
  );
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-anchor-a"));
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-anchor-b"));

  console.log(
    "\na stale owner's post-delivery write must not clobber a newer owner's result (NEW-3 / RELATED MINOR regression)"
  );
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-stale",
    payload: { title: "raced across an expired lease" },
  });
  let staleClaimedSignal!: () => void;
  const staleClaimed = new Promise<void>((resolve) => {
    staleClaimedSignal = resolve;
  });
  let resolveStaleDeliver!: (result: DeliverResult) => void;
  const staleDeliverPromise = new Promise<DeliverResult>((resolve) => {
    resolveStaleDeliver = resolve;
  });
  const staleDrain = drainOutbox({
    budgetMs: 10_000,
    max: 10,
    deliver: async (item) => {
      if (item.entityId !== "rem-stale") return { ok: true, remoteId: "n/a" };
      staleClaimedSignal();
      // Hangs until the test resolves it below, simulating a delivery that is still in
      // flight when its lease is later reclaimed by a newer drain.
      return staleDeliverPromise;
    },
  });
  await staleClaimed;

  // Simulate the lease having actually expired while the stale drain was still in flight —
  // compressed from the real 30s CLAIM_LEASE_MS into an instant, for a fast, deterministic
  // test. This is exactly the state a real expiry would leave the row in: the claim has
  // lapsed (`claimedUntil` in the past) while `nextAttemptAt` still says the row is due.
  // `claimedBy` is deliberately left alone — a real expiry does not clear it either, and the
  // point of the test is that the STALE owner's uuid no longer matches whoever takes it next.
  await db
    .update(connectorOutbox)
    .set({ claimedUntil: new Date(Date.now() - 1_000) })
    .where(eq(connectorOutbox.entityId, "rem-stale"));

  // A second, legitimately later drain now re-claims and delivers it for real.
  const newerStats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async () => ({ ok: true, remoteId: "remote-newer-owner" }),
  });
  check("the newer owner actually delivered it", newerStats.delivered === 1, JSON.stringify(newerStats));
  const [afterNewer] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-stale"));
  check("the row is delivered by the newer owner", afterNewer?.status === "delivered");
  const newerOwnerAttempts = afterNewer?.attempts;

  // Now the stale drain's delivery finally "comes back" — with a failure, the worst-case
  // direction: an unguarded post-delivery write would stomp the newer owner's `delivered`
  // status back to `pending`.
  resolveStaleDeliver({ ok: false, error: "stale owner finally timed out" });
  const staleStats = await staleDrain;
  check("the stale write is counted as stale, not a failure", staleStats.stale === 1, JSON.stringify(staleStats));

  const [afterStale] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-stale"));
  check(
    "the stale owner's write did not clobber the newer owner's result",
    afterStale?.status === "delivered",
    `status=${afterStale?.status} lastError=${afterStale?.lastError}`
  );
  check(
    "the newer owner's attempts count stands",
    afterStale?.attempts === newerOwnerAttempts,
    String(afterStale?.attempts)
  );
  check("no stale error was written over the newer owner's result", afterStale?.lastError === null);
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-stale"));

  console.log(
    "\nan abandoned owner's write must not land on a revived row's new owner (ABA regression)"
  );
  // The failure that forced the round-4 redesign, reproduced end to end. The old claim token
  // was the row's `attempts` value, and `enqueueOutbox` resets `attempts` to 0 when it revives
  // a delivered row — so the token RECURRED and a long-abandoned drain's write matched a live,
  // in-flight row. Verified failing against the pre-redesign implementation (3 of the 8 checks
  // below), and passing against the identity-based claim.
  const abaEnqueue = () =>
    enqueueOutbox({
      userId: USER,
      connectorId: "apple_reminders",
      action: "writeTask",
      entityType: "reminder",
      entityId: "rem-aba",
      payload: { title: "ABA" },
    });
  await abaEnqueue();

  // Drain A claims it and hangs.
  let aClaimedSignal!: () => void;
  const aClaimed = new Promise<void>((resolve) => {
    aClaimedSignal = resolve;
  });
  let resolveADeliver!: (result: DeliverResult) => void;
  const aDeliverPromise = new Promise<DeliverResult>((resolve) => {
    resolveADeliver = resolve;
  });
  const drainA = drainOutbox({
    budgetMs: 10_000,
    max: 5,
    deliver: async () => {
      aClaimedSignal();
      return aDeliverPromise;
    },
  });
  await aClaimed;

  // A's lease lapses while A is still in flight. Written as raw SQL touching BOTH columns so
  // this section reproduces identically against the pre-redesign code, where the lease lived
  // in `next_attempt_at`, and against this one, where it lives in `claimed_until`.
  await db.execute(
    sql`UPDATE connector_outbox SET next_attempt_at = now() - interval '1 second',
          claimed_until = now() - interval '1 second' WHERE entity_id = 'rem-aba'`
  );

  // Drain B legitimately takes over and delivers.
  const abaBStats = await drainOutbox({
    budgetMs: 5_000,
    max: 5,
    deliver: async () => ({ ok: true, remoteId: "remote-aba-b" }),
  });
  check(
    "B delivered it while A was still in flight",
    abaBStats.delivered === 1,
    JSON.stringify(abaBStats)
  );

  // The user re-triggers the action. THIS is the reset that made the old token recur.
  const abaRevived = await abaEnqueue();
  check("the re-trigger revived the row", abaRevived !== null);

  // Drain C claims the revived row and is now the live owner, mid-delivery.
  let cClaimedSignal!: () => void;
  const cClaimed = new Promise<void>((resolve) => {
    cClaimedSignal = resolve;
  });
  let resolveCDeliver!: (result: DeliverResult) => void;
  const cDeliverPromise = new Promise<DeliverResult>((resolve) => {
    resolveCDeliver = resolve;
  });
  const drainC = drainOutbox({
    budgetMs: 10_000,
    max: 5,
    deliver: async () => {
      cClaimedSignal();
      return cDeliverPromise;
    },
  });
  await cClaimed;
  const [abaInFlight] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-aba"));
  const abaCAttempts = abaInFlight?.attempts;
  const abaCNextAttemptAt = abaInFlight?.nextAttemptAt?.getTime() ?? 0;

  // Only now does A's ancient delivery come back — with a failure, the harmful direction.
  resolveADeliver({ ok: false, error: "A's ancient failure" });
  const abaAStats = await drainA;
  check(
    "A's write is a no-op counted as stale, not a failure",
    abaAStats.stale === 1 && abaAStats.failed === 0,
    JSON.stringify(abaAStats)
  );
  const [afterA] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-aba"));
  check("C's in-flight row is still pending", afterA?.status === "pending", String(afterA?.status));
  check(
    "C's attempt count is untouched",
    afterA?.attempts === abaCAttempts,
    `${afterA?.attempts} vs ${abaCAttempts}`
  );
  check(
    "A's error was not written onto C's row",
    afterA?.lastError === null,
    String(afterA?.lastError)
  );
  check(
    "A's write did not reschedule C's row",
    Math.abs((afterA?.nextAttemptAt?.getTime() ?? 0) - abaCNextAttemptAt) < 1_000,
    `${afterA?.nextAttemptAt?.toISOString()} vs ${new Date(abaCNextAttemptAt).toISOString()}`
  );

  // And C, the legitimate owner, still gets to record its own outcome.
  resolveCDeliver({ ok: true, remoteId: "remote-aba-c" });
  const abaCStats = await drainC;
  check("C's own delivery still lands", abaCStats.delivered === 1, JSON.stringify(abaCStats));
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-aba"));

  console.log(
    "\nthe failure backoff and the bookkeeping stamps anchor at resolution, not drain start"
  );
  // Round 3 fixed the LEASE's anchor but nothing covered the failure path's backoff anchor or
  // the `lastAttemptedAt`/`deliveredAt` stamps — a mutation of the backoff anchor left the
  // whole suite green. At the production budget (40s) a late item's backoff was quietly
  // shortened by however long the drain had already been running, and its timestamps were
  // that far stale. Two items: the first deliberately slow, so the second is resolved a
  // measurable distance from the drain's start.
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-anchor-slow",
    payload: { title: "slow but fine" },
  });
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-anchor-fail",
    payload: { title: "fails late in the drain" },
  });
  await db
    .update(connectorOutbox)
    .set({ nextAttemptAt: new Date(Date.now() - 10_000) })
    .where(eq(connectorOutbox.entityId, "rem-anchor-slow"));
  await db
    .update(connectorOutbox)
    .set({ nextAttemptAt: new Date(Date.now() - 5_000) })
    .where(eq(connectorOutbox.entityId, "rem-anchor-fail"));

  const ANCHOR_SLOW_MS = 3_000; // must exceed ANCHOR_TOLERANCE_MS by a wide margin
  const ANCHOR_TOLERANCE_MS = 1_500;
  // The real ladder jitters ±20% — for attempt 1 that is a 48-SECOND band, far wider than any
  // delay a smoke test can afford to sit through, so against the real ladder a 3s anchor error
  // hides inside the jitter and the check passes ~94% of the time. (Confirmed: a mutation that
  // anchored the backoff at drain start survived the in-band version of this check.) The
  // `backoffMs` override fixes the DURATION so the ANCHOR is the only thing left varying. It
  // cannot express an anchor itself, so it cannot paper over the bug it is here to catch. The
  // default ladder is still exercised, un-overridden, by the in-band check further down.
  const FIXED_BACKOFF_MS = 120_000;
  const anchorResolved: { slowAt: number; failAt: number } = { slowAt: 0, failAt: 0 };
  await drainOutbox({
    budgetMs: 20_000,
    max: 10,
    backoffMs: () => FIXED_BACKOFF_MS,
    deliver: async (item) => {
      if (item.entityId === "rem-anchor-slow") {
        await new Promise((resolve) => setTimeout(resolve, ANCHOR_SLOW_MS));
        anchorResolved.slowAt = Date.now();
        return { ok: true, remoteId: "remote-anchor-slow" };
      }
      anchorResolved.failAt = Date.now();
      return { ok: false, error: "provider said no" };
    },
  });

  const [anchorSlow] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-anchor-slow"));
  check(
    "deliveredAt is stamped when the delivery finished, not when the drain started",
    Math.abs((anchorSlow?.deliveredAt?.getTime() ?? 0) - anchorResolved.slowAt) <
      ANCHOR_TOLERANCE_MS,
    `deliveredAt=${anchorSlow?.deliveredAt?.toISOString()} resolvedAt=${new Date(anchorResolved.slowAt).toISOString()}`
  );

  const [anchorFail] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-anchor-fail"));
  const failAttemptedAt = anchorFail?.lastAttemptedAt?.getTime() ?? 0;
  const failNextAttemptAt = anchorFail?.nextAttemptAt?.getTime() ?? 0;
  check(
    "lastAttemptedAt is stamped when the attempt finished, not when the drain started",
    Math.abs(failAttemptedAt - anchorResolved.failAt) < ANCHOR_TOLERANCE_MS,
    `lastAttemptedAt=${anchorFail?.lastAttemptedAt?.toISOString()} resolvedAt=${new Date(anchorResolved.failAt).toISOString()}`
  );
  // Both stamps come from the SAME statement's `now()`, so with the duration pinned their gap
  // must be EXACTLY the backoff. Anchoring the schedule at drain start instead shortens it by
  // however long the drain had already been running — here, ANCHOR_SLOW_MS.
  const scheduledGap = failNextAttemptAt - failAttemptedAt;
  check(
    "the retry is exactly one backoff after the recorded attempt",
    Math.abs(scheduledGap - FIXED_BACKOFF_MS) < 1_000,
    `gap=${scheduledGap}ms, expected ~${FIXED_BACKOFF_MS}ms`
  );
  check(
    "and exactly one backoff after the delivery actually failed",
    Math.abs(failNextAttemptAt - anchorResolved.failAt - FIXED_BACKOFF_MS) < ANCHOR_TOLERANCE_MS,
    `${failNextAttemptAt - anchorResolved.failAt}ms, expected ~${FIXED_BACKOFF_MS}ms`
  );
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-anchor-slow"));
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-anchor-fail"));

  console.log("\na leased row is not claimable, even when its retry is due");
  // The claimability predicate, exercised end to end: a row can be due for a retry and still
  // be owned by somebody. This is the property the staggered-drain section relies on but only
  // ever demonstrated indirectly, through two racing drains.
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-leased",
    payload: { title: "owned by someone else" },
  });
  await db.execute(
    sql`UPDATE connector_outbox
           SET next_attempt_at = now() - interval '1 hour',
               claimed_by = gen_random_uuid(),
               claimed_until = now() + interval '1 hour'
         WHERE entity_id = 'rem-leased'`
  );
  let leasedDeliverCalls = 0;
  const leasedStats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async () => {
      leasedDeliverCalls++;
      return { ok: true, remoteId: "should-not-happen" };
    },
  });
  check("a leased row is not attempted", leasedStats.attempted === 0, JSON.stringify(leasedStats));
  check("deliver was never invoked for it", leasedDeliverCalls === 0);
  const [leasedRow] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-leased"));
  check("its attempt count is untouched", leasedRow?.attempts === 0, String(leasedRow?.attempts));
  await db.delete(connectorOutbox).where(eq(connectorOutbox.entityId, "rem-leased"));

  console.log("\nthe claim keeps the safety properties PGlite cannot exercise (source guard)");
  // These three are assertions about the SQL TEXT, not about behaviour, and they are here
  // because the behaviour is not reachable from this harness:
  //
  //   - PGlite is one in-process backend that serializes every query, so two sessions never
  //     contend for a row lock. Nothing here can distinguish a claim that is safe only
  //     because of `FOR UPDATE SKIP LOCKED` from one that is safe without it. Dropping
  //     SKIP LOCKED passes every behavioural check in this file — confirmed by mutation.
  //   - app and database share a clock in this harness, so a lease computed in JavaScript is
  //     indistinguishable from one computed by the database. That mutation passes too.
  //
  // A source guard is a weak instrument and it is used here only where the strong one cannot
  // reach. It is mutation-tested like everything else: removing either predicate, or moving
  // the lease onto a JavaScript clock, fails one of these.
  const outboxSrc = readFileSync("src/lib/connectors/outbox.ts", "utf8");
  const CLAIMABLE = "(claimed_until IS NULL OR claimed_until < now())";
  // Anchored at `SET claimed_by`, the first line of the claim statement itself, so the module
  // header's prose description of the same SQL cannot satisfy the guard.
  const stmt = outboxSrc.slice(outboxSrc.indexOf("SET claimed_by"));
  const subselectAt = stmt.indexOf("AND id = (");
  const outerHalf = subselectAt >= 0 ? stmt.slice(0, subselectAt) : "";
  const innerHalf = subselectAt >= 0 ? stmt.slice(subselectAt) : "";
  check(
    "the claimability predicate is on the outer UPDATE, so mutual exclusion does not rest on SKIP LOCKED",
    outerHalf.includes(CLAIMABLE),
    subselectAt < 0 ? "no `AND id = (` found in the claim statement" : "outer half lacks it"
  );
  check(
    "and still inside the subselect, so an unclaimable row is never picked in the first place",
    innerHalf.includes(CLAIMABLE)
  );
  // Read off the whole statement, not `outerHalf`, so that removing the subselect anchor
  // fails only the two checks it actually concerns rather than cascading into this one.
  check(
    "the lease is anchored by the database, not by a JavaScript clock",
    stmt.includes("claimed_until = now() +")
  );

  console.log("\nexternal_links has exactly one writer, and it is the claim-guarded one");
  // The unguarded `recordExternalLink` twin is gone (it had no caller): an unclaimed upsert is
  // how a lapsed owner writes an older remote id over a live owner's newer one. The upsert
  // behaviour it used to be tested for is covered above, through the drain — which is the only
  // way it can be reached now. This guard is about the SOURCE, because "no second writer
  // exists" is not a runtime property of any one call.
  const linkWrites = outboxSrc.match(/(INSERT INTO external_links|\.insert\(externalLinks\))/g) ?? [];
  check(
    "only one statement writes external_links",
    linkWrites.length === 1,
    `${linkWrites.length}: ${linkWrites.join(", ")}`
  );
  check(
    "and it is guarded on the claim",
    /INSERT INTO external_links[\s\S]{0,600}?claimed_by = \$\{input\.worker\}/.test(outboxSrc)
  );

  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  await db.delete(externalLinks).where(eq(externalLinks.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outbox checks passed.");
});
