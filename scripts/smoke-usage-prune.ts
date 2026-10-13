/**
 * The usage_events retention sweep must not delete the spend a still-open provider pool is
 * counting (`MANAGED_AI_POOLS`): the prepaid OpenAI pool never resets, so its Orbit-paid rows
 * stay the pool's ledger long past the 180-day retention. BYOK rows and Orbit rows from before
 * the window are still pruned. Run: npx tsx scripts/smoke-usage-prune.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents } from "../src/db/schema";
import { pruneOlderThan, pruneUsageEvents } from "../src/lib/event-prune";
import { earliestPoolWindowStart } from "../src/lib/managed-ai-policy";

const USER = "smoke-usage-prune-user";
const DAY = 86_400_000;
const RETENTION_DAYS = 180;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  const cleanup = () => db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  await cleanup();
  try {
    // Far enough out that a prepaid pool's window (no reset) is older than the retention
    // while still open; a monthly pool's window is always recent, so it never sets `earliest`.
    const now = new Date(Date.now() + 400 * DAY);
    const earliest = earliestPoolWindowStart(now);
    if (!earliest) throw new Error("no managed pools configured: nothing for the prune to protect");
    const cutoff = now.getTime() - RETENTION_DAYS * DAY;

    const row = (label: string, keyOwner: "user" | "orbit", createdAt: Date) => ({
      userId: USER, operation: `smoke.${label}`, provider: "openai" as const, model: "m", kind: "completion" as const,
      keyOwner, estimatedCostMicros: 1_000, success: 1, createdAt,
    });
    await db.insert(usageEvents).values([
      row("orbit-in-window", "orbit", new Date(earliest.getTime() + 10 * DAY)),
      row("byok-in-window", "user", new Date(earliest.getTime() + 10 * DAY)),
      row("orbit-before-window", "orbit", new Date(earliest.getTime() - 10 * DAY)),
      row("byok-before-window", "user", new Date(earliest.getTime() - 10 * DAY)),
      row("orbit-fresh", "orbit", new Date(now.getTime() - DAY)),
      row("byok-fresh", "user", new Date(now.getTime() - DAY)),
    ]);

    const pruned = await pruneUsageEvents(RETENTION_DAYS, now);
    const left = new Set((await db.select({ op: usageEvents.operation }).from(usageEvents).where(eq(usageEvents.userId, USER))).map((r) => r.op.replace("smoke.", "")));

    check("an old Orbit row inside the pool window survives", left.has("orbit-in-window"), [...left].join(", "));
    check("an old BYOK row inside the window is deleted", !left.has("byok-in-window"));
    check("an Orbit row older than the window is deleted", !left.has("orbit-before-window"));
    check("an old BYOK row older than the window is deleted", !left.has("byok-before-window"));
    check("rows inside the retention are kept", left.has("orbit-fresh") && left.has("byok-fresh"));
    check("the sweep reports what it deleted", pruned >= 3, String(pruned));
    check("the guarded row is past retention, so only the guard kept it (update `now` if the pools changed)",
      earliest.getTime() + 10 * DAY < cutoff, earliest.toISOString());

    // Other tables prune through the same helper with no guard.
    await db.insert(usageEvents).values(row("unguarded", "orbit", new Date(earliest.getTime() + 10 * DAY)));
    await pruneOlderThan(usageEvents, RETENTION_DAYS, undefined, now);
    const after = (await db.select({ op: usageEvents.operation }).from(usageEvents).where(eq(usageEvents.userId, USER))).map((r) => r.op);
    check("without a keep clause the helper deletes every old row, as before", !after.includes("smoke.unguarded") && !after.includes("smoke.orbit-in-window"));
  } finally {
    await cleanup();
  }
});
