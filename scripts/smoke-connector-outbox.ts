/**
 * The write-back queue.
 *
 * Enqueue must be idempotent — the same follow-up must not create two tasks in someone's
 * Reminders — and the drain must survive one connector failing without stalling the queue.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorOutbox, externalLinks } from "../src/db/schema";
import {
  drainOutbox,
  enqueueOutbox,
  findExternalLink,
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
  check("the same action does not enqueue twice", again === null);

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

  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  await db.delete(externalLinks).where(eq(externalLinks.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outbox checks passed.");
});
